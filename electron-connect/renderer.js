const statusCard = document.getElementById("statusCard");
const apiBaseUrl = document.getElementById("apiBaseUrl");
const tokenState = document.getElementById("tokenState");
const accountReferenceInput = document.getElementById("accountReference");
const openLoginButton = document.getElementById("openLoginButton");

let launchState = {
  flow: "dld",
  token: "",
  apiBaseUrl: "",
  accountReference: "",
};

function isFbrFlow() {
  return launchState.flow === "fbr";
}

function setStatus(kind, message) {
  statusCard.className = `status status-${kind}`;
  statusCard.textContent = message;
}

function renderLaunchState(nextState) {
  launchState = {
    flow: nextState?.flow === "fbr" ? "fbr" : "dld",
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
        : "Connection request received. MyDLD sign-in will open automatically, and this trusted device will be marked ready after login.",
    );
  } else {
    setStatus("idle", "Waiting for a connection request from the web app.");
  }
}

async function bootstrap() {
  const initial = await window.ejariConnect.getLaunchState();
  renderLaunchState(initial);

  window.ejariConnect.onLaunchState((payload) => {
    renderLaunchState(payload);
  });

  window.ejariConnect.onStatusUpdate((payload) => {
    setStatus(payload?.kind || "idle", payload?.message || "Waiting for a connection request from the web app.");
  });
}

accountReferenceInput.addEventListener("input", async () => {
  try {
    await window.ejariConnect.setAccountReference(accountReferenceInput.value);
  } catch {
    // Ignore local sync errors; auto-capture can proceed without this optional value.
  }
});

openLoginButton.addEventListener("click", async () => {
  try {
    await window.ejariConnect.openDldLogin();
    setStatus(
      "progress",
      isFbrFlow()
        ? "Official Iris login opened. Finish the local sign-in there and this trusted device will be marked ready automatically."
        : "Official MyDLD login opened. Finish sign-in there and this trusted device will be marked ready automatically.",
    );
  } catch (error) {
    setStatus("error", error instanceof Error ? error.message : "The login window could not be opened.");
  }
});

bootstrap();
