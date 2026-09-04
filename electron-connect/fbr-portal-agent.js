/**
 * TaxRocket Portal Agent - Portal Automation Logic
 * Implements job polling, IRIS field filling using portalFieldMap, pause handling
 * This file runs in main process or renderer - uses webContents.executeJavaScript for IRIS automation
 */

const POLLING_INTERVAL_MS = 3000;

class PortalAgent {
  constructor({ deviceToken, baseUrl, partitionKey, mainWindow }) {
    this.deviceToken = deviceToken;
    this.baseUrl = baseUrl || 'http://localhost:3000';
    this.partitionKey = partitionKey;
    this.mainWindow = mainWindow;
    this.currentJob = null;
    this.isPolling = false;
    this.pollTimer = null;
  }

  startPolling() {
    if (this.isPolling) return;
    this.isPolling = true;
    console.log('[PortalAgent] Starting job polling every', POLLING_INTERVAL_MS, 'ms');
    this.pollTimer = setInterval(() => this.pollNextJob(), POLLING_INTERVAL_MS);
    this.pollNextJob(); // Immediate first poll
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = false;
    console.log('[PortalAgent] Polling stopped');
  }

  async pollNextJob() {
    try {
      const res = await fetch(`${this.baseUrl}/api/local-agent/jobs/next`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceToken: this.deviceToken }),
      });
      const data = await res.json();
      
      if (data.success && data.job) {
        console.log('[PortalAgent] Found job:', data.job.id, data.job.jobType, data.job.status);
        
        if (!this.currentJob || this.currentJob.id !== data.job.id) {
          this.currentJob = data.job;
          await this.handleJob(data.job);
        } else if (data.job.status === 'awaiting_user_action') {
          // Job is paused - update UI
          console.log('[PortalAgent] Job paused:', data.job.pauseAction, data.job.pauseMessage);
          this.currentJob = data.job;
          this.notifyRenderer('job-paused', data.job);
        }
      } else {
        // No job
        // console.log('[PortalAgent] No jobs');
      }
    } catch (e) {
      console.error('[PortalAgent] Poll failed:', e.message);
    }
  }

  async handleJob(job) {
    console.log(`[PortalAgent] Handling job ${job.id} type ${job.jobType}`);
    this.notifyRenderer('job-started', job);

    // Fetch context with portalFieldMap
    try {
      const contextRes = await fetch(`${this.baseUrl}/api/local-agent/jobs/${job.id}/context?deviceToken=${encodeURIComponent(this.deviceToken)}`);
      const contextData = await contextRes.json();

      if (!contextData.success) {
        throw new Error(contextData.error || 'Failed to fetch context');
      }

      console.log('[PortalAgent] Context fetched, packet v', contextData.packet.version);
      console.log('[PortalAgent] PortalFieldMap fields:', contextData.snapshot.portalFieldMap?.totalFields);

      // Update job to running
      await this.updateJobStatus(job.id, 'running', { message: 'Context fetched, starting IRIS automation' });

      // Start IRIS automation
      if (job.jobType === 'tax_dry_run') {
        await this.runDryRun(job, contextData);
      } else if (job.jobType === 'tax_assisted_filing') {
        await this.runAssistedFiling(job, contextData);
      }

    } catch (e) {
      console.error('[PortalAgent] Job handling failed:', e);
      await this.updateJobStatus(job.id, 'failed', { error: e.message });
      this.notifyRenderer('job-failed', { jobId: job.id, error: e.message });
    }
  }

  async runDryRun(job, context) {
    console.log('[PortalAgent] Starting dry run for packet', context.packet.id);
    const portalFieldMap = context.snapshot.portalFieldMap;

    if (!portalFieldMap) {
      throw new Error('No portalFieldMap in packet - generate packet with new code');
    }

    // Simulate filling IRIS fields using portalFieldMap
    // In real implementation, this would use webContents.executeJavaScript to fill actual IRIS DOM
    for (const field of portalFieldMap.incomeFields) {
      console.log(`[PortalAgent] Filling IRIS code ${field.irisCode} (${field.irisDescription}) with ${field.ourAmount} from ${field.ourCategory}`);
      
      // Example selector execution (would be real in production):
      // await this.mainWindow.webContents.executeJavaScript(`
      //   document.querySelector('[data-system-code="${field.irisCode}"] input')?.value = '${field.ourAmount}';
      // `);

      // Simulate delay
      await new Promise(r => setTimeout(r, 100));
    }

    for (const taxField of portalFieldMap.adjustableTaxFields) {
      console.log(`[PortalAgent] Filling adjustable tax ${taxField.irisCode} (${taxField.irisDescription}) with ${taxField.ourAmount}`);
      await new Promise(r => setTimeout(r, 100));
    }

    // Capture screenshot (simulated)
    const screenshot = await this.captureScreenshot();

    // Check for review gate - stop before final submit for dry run
    console.log('[PortalAgent] Dry run completed, stopping at review gate (no final submit)');

    await this.updateJobStatus(job.id, 'completed', {
      result: {
        dryRun: true,
        fieldsFilled: portalFieldMap.totalFields,
        packetVersion: context.packet.version,
        screenshots: [screenshot],
      },
    });

    this.notifyRenderer('job-completed', { jobId: job.id, type: 'dry_run', fields: portalFieldMap.totalFields });
    this.currentJob = null;
  }

  async runAssistedFiling(job, context) {
    console.log('[PortalAgent] Starting assisted filing');
    // Similar to dry run but with pause points
    const pausePoints = ['otp_required', 'captcha_required', 'pin_required', 'final_review'];

    for (const pause of pausePoints) {
      console.log(`[PortalAgent] Reached pause point: ${pause}`);
      await this.updateJobStatus(job.id, 'awaiting_user_action', {
        pauseAction: pause,
        pauseMessage: `Please complete ${pause} in IRIS portal. This stays local, never sent to server.`,
      });

      this.notifyRenderer('job-paused', { jobId: job.id, pauseAction: pause });

      // Wait for user to resume (polling will detect resume via backend)
      // In real implementation, this would wait for IPC from renderer that user confirmed OTP etc
      await this.waitForResume(job.id);
    }

    // Final submit would be here after all pauses
    console.log('[PortalAgent] Assisted filing completed - final submit done by user in IRIS');

    await this.updateJobStatus(job.id, 'completed', {
      result: { assistedFiling: true, completedAt: new Date().toISOString() },
    });

    this.notifyRenderer('job-completed', { jobId: job.id, type: 'assisted_filing' });
    this.currentJob = null;
  }

  async waitForResume(jobId) {
    // Poll backend to see if job was resumed by user via web UI
    return new Promise((resolve) => {
      const checkInterval = setInterval(async () => {
        try {
          const res = await fetch(`${this.baseUrl}/api/local-agent/jobs/next`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceToken: this.deviceToken }),
          });
          const data = await res.json();
          if (data.success && data.job && data.job.id === jobId && data.job.status === 'running') {
            clearInterval(checkInterval);
            resolve();
          }
        } catch (e) {
          // ignore
        }
      }, 2000);

      // Timeout after 30 minutes for safety
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, 30 * 60 * 1000);
    });
  }

  async updateJobStatus(jobId, status, { pauseAction, pauseMessage, result, error, message } = {}) {
    try {
      const body = {
        deviceToken: this.deviceToken,
        status,
        pauseAction,
        pauseMessage,
        result,
        error,
        logs: message ? [{ timestamp: new Date().toISOString(), message }] : undefined,
      };

      const res = await fetch(`${this.baseUrl}/api/local-agent/jobs/${jobId}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      console.log(`[PortalAgent] Status update ${jobId} -> ${status}:`, data.success ? 'ok' : data.error);
      return data;
    } catch (e) {
      console.error('[PortalAgent] Status update failed:', e.message);
      return { success: false };
    }
  }

  async captureScreenshot() {
    try {
      if (this.mainWindow) {
        const image = await this.mainWindow.webContents.capturePage();
        // In real app, save to file and upload to GCS, return URL
        // For now, return placeholder
        return { timestamp: new Date().toISOString(), placeholder: true, size: image.getSize() };
      }
    } catch (e) {
      console.error('[PortalAgent] Screenshot failed:', e.message);
    }
    return null;
  }

  notifyRenderer(channel, data) {
    if (this.mainWindow) {
      this.mainWindow.webContents.send(channel, data);
    }
  }
}

module.exports = { PortalAgent };
