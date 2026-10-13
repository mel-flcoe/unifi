const form = document.querySelector("#settings");
const input = document.querySelector("#poll-seconds");
const message = document.querySelector("#settings-message");

const current = await fetch("/api/settings", { cache: "no-store" });
const settings = await current.json();
input.value = settings.pollSeconds;

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
