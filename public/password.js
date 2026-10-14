const form = document.querySelector("#password-form");
const message = document.querySelector("#password-message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  if (form.newPassword.value !== form.confirmPassword.value) {
    message.textContent = "Those new passwords do not match.";
    return;
  }
  message.textContent = "Saving…";
  const response = await fetch("/api/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      currentPassword: form.currentPassword.value,
      newPassword: form.newPassword.value,
      confirmPassword: form.confirmPassword.value,
    }),
  });
  if (response.status === 401) {
    location.href = "/login";
    return;
  }
  const body = await response.json();
  if (!response.ok) {
    message.textContent = body.error || "Could not change that password.";
    return;
  }
  form.reset();
  message.textContent = "Password updated.";
});
