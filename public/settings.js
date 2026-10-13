const form = document.querySelector("#settings");
const input = document.querySelector("#poll-seconds");
const message = document.querySelector("#settings-message");
const logoForm = document.querySelector("#logo-form");
const logoInput = document.querySelector("#logo");
const logoMessage = document.querySelector("#logo-message");
const preview = document.querySelector("#logo-preview");
const removeLogo = document.querySelector("#remove-logo");
const headerLogo = document.querySelector("#site-logo");

const current = await fetch("/api/settings", { cache: "no-store" });
if (current.status === 401) location.href = "/login";
const settings = await current.json();
input.value = settings.pollSeconds;
showLogo(settings.hasLogo);

function showLogo(hasLogo) {
  const src = `/logo?t=${Date.now()}`;
  removeLogo.hidden = !hasLogo;
  preview.hidden = !hasLogo;
  if (hasLogo) preview.src = src;
  if (headerLogo && hasLogo) {
    headerLogo.hidden = false;
    headerLogo.src = src;
  }
  if (headerLogo && !hasLogo) headerLogo.hidden = true;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "Saving…";
  const response = await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pollSeconds: Number(input.value) }),
  });
  const body = await response.json();
  if (!response.ok) {
    message.textContent = body.error || "Could not save that interval.";
    return;
  }
  input.value = body.pollSeconds;
  message.textContent = `Saved. UniFi is checked every ${body.pollSeconds} seconds.`;
});

logoForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = logoInput.files?.[0];
  if (!file) {
    logoMessage.textContent = "Choose an image first.";
    return;
  }
  logoMessage.textContent = "Saving…";
  const response = await fetch("/api/logo", {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  const body = await response.json();
  if (!response.ok) {
    logoMessage.textContent = body.error || "Could not save that logo.";
    return;
  }
  logoInput.value = "";
  showLogo(true);
  logoMessage.textContent = "Logo saved.";
});

removeLogo.addEventListener("click", async () => {
  logoMessage.textContent = "Removing…";
  const response = await fetch("/api/logo", { method: "DELETE" });
  const body = await response.json();
  if (!response.ok) {
    logoMessage.textContent = body.error || "Could not remove the logo.";
    return;
  }
  showLogo(false);
  logoMessage.textContent = "Logo removed.";
});
