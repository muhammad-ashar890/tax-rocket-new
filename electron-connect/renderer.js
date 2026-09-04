const statusCard = document.getElementById("statusCard");
const apiBaseUrl = document.getElementById("apiBaseUrl");
const tokenState = document.getElementById("tokenState");
const accountReferenceInput = document.getElementById("accountReference");
const openLoginButton = document.getElementById("openLoginButton");

const agent = window.taxRocketAgent;

let launchState = {
  flow: "fbr",
  token: "",
  apiBaseUrl: "",
  accountReference: "",
};

function isFbrFlow() {
  return launchState.flow !== "dld";
}

function setStatus(kind, message) {
  statusCard.className = `status status-${kind}`;
  statusCard.textContent = message;
}

function renderLaunchState(nextState) {
  launchState = {
    flow: nextState?.flow === "dld" ? "dld" : "fbr",
    token: nextState?.token || "",
    apiBaseUrl: nextState?.apiBaseUrl || "",
    accountReference: nextState?.accountReference || "",
  };

  if (accountReferenceInput.value !== launchState.accountReference) {
    accountReferenceInput.value = launchState.accountReference;
  }

  apiBaseUrl.textContent = launchState.apiBaseUrl || "Not connected";
  tokenState.textContent = launchState.token ? "Ready" : "Not received";

  if (launchState.token && launchState.apiBaseUrl) {
    setStatus(
      "ready",
      isFbrFlow()
        ? "Connection request received. Iris sign-in will open automatically, and this trusted device will be marked ready after the local ready screen is detected."
        : "Connection request received. Portal sign-in will open automatically, and this trusted device will be marked ready after login.",
    );
  } else {
    setStatus("idle", "Waiting for a connection request from the web app.");
  }
}

async function bootstrap() {
  const initial = await agent.getLaunchState();
  renderLaunchState(initial);

  agent.onLaunchState((payload) => {
    renderLaunchState(payload);
  });

  agent.onStatusUpdate((payload) => {
    setStatus(
      payload?.kind || "idle",
      payload?.message || "Waiting for a connection request from the web app.",
    );
  });
}

accountReferenceInput.addEventListener("input", async () => {
  try {
    await agent.setAccountReference(accountReferenceInput.value);
  } catch {
    // Ignore local sync errors; auto-capture can proceed without this optional value.
  }
});

openLoginButton.addEventListener("click", async () => {
  try {
    await agent.openPortalLogin();
    setStatus(
      "progress",
      isFbrFlow()
        ? "Official Iris login opened. Finish the local sign-in there and this trusted device will be marked ready automatically."
        : "Official portal login opened. Finish sign-in there and this trusted device will be marked ready automatically.",
    );
  } catch (error) {
    setStatus(
      "error",
      error instanceof Error
        ? error.message
        : "The login window could not be opened.",
    );
  }
});

bootstrap();
