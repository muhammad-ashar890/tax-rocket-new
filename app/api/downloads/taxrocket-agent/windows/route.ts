import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/downloads/taxrocket-agent/windows
 * Serves TaxRocket Portal Agent installer
 * 
 * In production, this would redirect to GCS signed URL
 * For now, returns placeholder with instructions
 * 
 * Also handles legacy endpoint: /api/downloads/dld-connection/windows
 */

export async function GET(req: NextRequest) {
  const gcsBucket = process.env.GCS_BUCKET_NAME;
  const installerPath = process.env.TAXROCKET_AGENT_INSTALLER_PATH || "installers/taxrocket-portal-agent-latest.exe";
  const useGcs = process.env.USE_GCS === "true" && gcsBucket;

  // If GCS configured, redirect to signed URL (TODO: implement signed URL generation)
  if (useGcs) {
    // TODO: Generate GCS signed URL
    // For now, return instruction
    return NextResponse.json({
      success: false,
      message: "GCS bucket configured but signed URL generation not yet implemented",
      bucket: gcsBucket,
      path: installerPath,
      instructions: "Implement GCS signed URL in this endpoint. See worker.md: npm run desktop-installer:upload",
    }, { status: 501 });
  }

  // Development placeholder - check if local file exists
  const baseUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  
  return NextResponse.json({
    success: false,
    message: "Desktop Agent installer not yet built",
    expectedEndpoints: {
      new: "/api/downloads/taxrocket-agent/windows",
      legacy: "/api/downloads/dld-connection/windows (still supported for backward compat)",
    },
    buildInstructions: {
      dev: "npm run desktop-connect:dev (in electron-connect folder)",
      build: "npm --prefix electron-connect run dist:win",
      upload: "npm run desktop-installer:upload (uploads to GCS)",
      env: {
        GCS_BUCKET_NAME: "your-bucket",
        USE_GCS: "true",
        TAXROCKET_AGENT_INSTALLER_PATH: "installers/taxrocket-portal-agent-latest.exe",
      },
    },
    electronFolder: "electron-connect/ (needs to be created or copied from old repo)",
    requiredFromClient: [
      "electron-connect folder source code (main.js, preload.js, portal-agent.js)",
      "package.json with electron-builder config",
      "GCS credentials if using cloud storage",
    ],
    nextSteps: "Client needs to provide electron-connect source or confirm if we should scaffold new Electron app",
  }, { status: 404 });
}
