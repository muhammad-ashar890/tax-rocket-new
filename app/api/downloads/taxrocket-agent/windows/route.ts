import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";
import { NextResponse } from "next/server";
import {
  findDesktopInstallerPath,
  installerDownloadName,
} from "@/lib/tax/desktop-installer";

/**
 * GET /api/downloads/taxrocket-agent/windows
 * Serves the local electron-builder .exe when present.
 */
export async function GET() {
  const gcsBucket = process.env.GCS_BUCKET_NAME;
  const useGcs = process.env.USE_GCS === "true" && gcsBucket;

  if (useGcs) {
    return NextResponse.json(
      {
        success: false,
        message:
          "GCS bucket configured but signed URL generation is not implemented yet.",
        bucket: gcsBucket,
      },
      { status: 501 },
    );
  }

  const filePath = findDesktopInstallerPath();
  if (filePath) {
    const info = await stat(filePath);
    const stream = Readable.toWeb(createReadStream(filePath)) as ReadableStream;
    return new NextResponse(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(info.size),
        "Content-Disposition": `attachment; filename="${installerDownloadName(filePath)}"`,
        "Cache-Control": "no-store",
      },
    });
  }

  return NextResponse.json(
    {
      success: false,
      message:
        "Installer .exe abhi build nahi hua. electron-connect folder mein npm run dist:win chalao.",
      buildInstructions: {
        cwd: "electron-connect",
        install: "npm install",
        build: "npm run dist:win",
        output: "electron-connect/dist/TaxRocket-Portal-Agent-Setup-1.0.0.exe",
      },
    },
    { status: 404 },
  );
}
