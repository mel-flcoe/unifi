const logo = document.querySelector("#site-logo");
if (logo) {
  logo.addEventListener("load", () => {
    logo.hidden = false;
  });
  logo.addEventListener("error", () => {
    logo.hidden = true;
  });
  logo.src = "/logo";
}

document.addEventListener("click", async (event) => {
  if (!event.target.closest("[data-logout]")) return;
  await fetch("/logout", { method: "POST" });
  location.href = "/login";
});
