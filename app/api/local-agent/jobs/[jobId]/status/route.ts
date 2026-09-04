import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  hashToken,
  JOB_STATUSES,
  normalizePauseAction,
} from "@/lib/tax/fbr-desktop";

/**
 * POST /api/local-agent/jobs/[jobId]/status
 * Electron agent reports job status updates
 * Body: { deviceToken, status, pauseAction?, pauseMessage?, result?, error?, screenshots?, logs?, resumeData? }
 *
 * Handles:
 * - running, awaiting_user_action (pause for OTP etc), completed, failed
 * - Pause actions: otp_required, captcha_required, pin_required, final_review, etc.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
) {
  try {
    const { jobId } = await params;
    const body = await req.json().catch(() => ({}) as any);
    const authHeader = req.headers.get("authorization") || "";
    const bearerToken = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : "";
    const deviceToken =
      (body as any)?.deviceToken ||
      (body as any)?.deviceAuthToken ||
      bearerToken;
    const {
      status,
      pauseAction,
      pauseMessage,
      result,
      error,
      screenshots,
      logs,
      resumeData,
    } = body as any;

    if (!deviceToken) {
      return NextResponse.json(
        {
          success: false,
          ok: false,
          error: "deviceToken required (body or Bearer)",
        },
        { status: 400 },
      );
    }

    if (!status) {
      return NextResponse.json(
        { success: false, error: "status required" },
        { status: 400 },
      );
    }

    const deviceTokenHash = hashToken(deviceToken);
    const device = await prisma.trustedDevice.findUnique({
      where: { deviceTokenHash },
    });

    if (!device || device.status !== "ACTIVE") {
      return NextResponse.json(
        { success: false, error: "Invalid device" },
        { status: 401 },
      );
    }

    const job = await prisma.localAgentJob.findFirst({
      where: {
        id: jobId,
        userId: device.userId,
      },
    });

    if (!job) {
      return NextResponse.json(
        { success: false, error: "Job not found" },
        { status: 404 },
      );
    }

    // Validate status transition
    const validStatuses = Object.values(JOB_STATUSES);
    if (!validStatuses.includes(status)) {
      return NextResponse.json(
        { success: false, error: `Invalid status: ${status}` },
        { status: 400 },
      );
    }

    // Prepare update data
    const updateData: any = {
      status,
      trustedDeviceId: device.id,
    };

    if (pauseAction) {
      updateData.pauseAction = normalizePauseAction(pauseAction);
      updateData.pauseMessage = pauseMessage || null;
    } else if (status !== JOB_STATUSES.AWAITING_USER_ACTION) {
      // Clear pause if not awaiting
      updateData.pauseAction = null;
      updateData.pauseMessage = null;
    }

    if (result) {
      updateData.resultJson =
        typeof result === "string" ? result : JSON.stringify(result);
    }

    if (error) {
      updateData.errorMessage =
        typeof error === "string" ? error : JSON.stringify(error);
    }

    if (screenshots) {
      updateData.screenshotsJson =
        typeof screenshots === "string"
          ? screenshots
          : JSON.stringify(screenshots);
    }

    if (logs) {
      updateData.logsJson =
        typeof logs === "string" ? logs : JSON.stringify(logs);
    }

    if (resumeData) {
      updateData.resumeDataJson =
        typeof resumeData === "string"
          ? resumeData
          : JSON.stringify(resumeData);
    }

    if (
      status === JOB_STATUSES.COMPLETED ||
      status === JOB_STATUSES.FAILED ||
      status === JOB_STATUSES.CANCELLED
    ) {
      updateData.completedAt = new Date();
    }

    if (status === JOB_STATUSES.RUNNING && !job.startedAt) {
      updateData.startedAt = new Date();
    }

    const updatedJob = await prisma.localAgentJob.update({
      where: { id: jobId },
      data: updateData,
    });

    // If job completed, update FbrConnection as well
    if (status === JOB_STATUSES.COMPLETED) {
      await prisma.fbrConnection.updateMany({
        where: {
          filingDraftId: job.filingDraftId,
          userId: device.userId,
        },
        data: {
          status:
            job.jobType === "tax_dry_run"
              ? "DRY_RUN_COMPLETED"
              : "FILING_COMPLETED",
          completedAt: new Date(),
          message: `Job ${job.jobType} completed`,
          lastHeartbeat: new Date(),
        },
      });
    }

    if (status === JOB_STATUSES.FAILED) {
      await prisma.fbrConnection.updateMany({
        where: {
          filingDraftId: job.filingDraftId,
          userId: device.userId,
        },
        data: {
          status: "FAILED",
          errorMessage: updateData.errorMessage || "Job failed",
          lastHeartbeat: new Date(),
        },
      });
    }

    // Audit
    await prisma.taxAuditEvent.create({
      data: {
        userId: device.userId,
        filingDraftId: job.filingDraftId,
        jobId: job.id,
        deviceId: device.id,
        eventType: `JOB_${status.toUpperCase()}`,
        eventDataJson: JSON.stringify({
          jobType: job.jobType,
          pauseAction: updateData.pauseAction,
          hasResult: !!result,
          hasError: !!error,
        }),
      },
    });

    // Update device last seen
    await prisma.trustedDevice.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });

    return NextResponse.json({
      success: true,
      ok: true,
      job: {
        id: updatedJob.id,
        status: updatedJob.status,
        pauseAction: updatedJob.pauseAction,
        pauseMessage: updatedJob.pauseMessage,
        completedAt: updatedJob.completedAt?.toISOString() || null,
      },
    });
  } catch (error) {
    console.error("Error updating job status:", error);
    return NextResponse.json(
      { success: false, error: "Failed to update job status" },
      { status: 500 },
    );
  }
}
