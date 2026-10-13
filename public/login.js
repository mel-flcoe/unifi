const form = document.querySelector("#login");
const message = document.querySelector("#login-error");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "";
  const response = await fetch("/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: form.email.value,
      password: form.password.value,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    message.textContent = body.error || "Could not sign in.";
    return;
  }
  location.href = "/";
});
