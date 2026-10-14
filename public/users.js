const rows = document.querySelector("#user-rows");
const form = document.querySelector("#user-form");
const picks = document.querySelector("#site-picks");
const siteField = document.querySelector("#site-field");
const message = document.querySelector("#user-message");
const title = document.querySelector("#form-title");
const saveButton = document.querySelector("#save-user");
const cancelButton = document.querySelector("#cancel-edit");
const passwordHint = document.querySelector("#password-hint");
let sites = [];
let users = [];

form.fullAccess.addEventListener("change", () => {
  siteField.hidden = form.fullAccess.checked;
});

cancelButton.addEventListener("click", () => {
  resetForm();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  message.textContent = "Saving…";
  const payload = {
    email: form.email.value,
    password: form.password.value,
    admin: form.admin.checked,
    fullAccess: form.fullAccess.checked,
    siteIds: [...picks.querySelectorAll("input:checked")].map((input) => input.value),
  };
  const idInput = form.elements.namedItem("id");
  const id = idInput.value;
  const response = await fetch(id ? `/api/users/${encodeURIComponent(id)}` : "/api/users", {
    method: id ? "PUT" : "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (!response.ok) {
    message.textContent = body.error || "Could not save that user.";
    return;
  }
  message.textContent = id ? "User updated." : "User added.";
  resetForm();
  await load();
});

rows.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const user = users.find((item) => item.id === button.dataset.id);
  if (!user) return;
  if (button.dataset.action === "edit") {
    form.elements.namedItem("id").value = user.id;
    form.email.value = user.email;
    form.password.value = "";
    form.admin.checked = user.admin;
    form.fullAccess.checked = user.fullAccess;
    siteField.hidden = user.fullAccess;
    for (const input of picks.querySelectorAll("input")) input.checked = user.siteIds.includes(input.value);
    title.textContent = "Edit user";
    saveButton.textContent = "Save user";
    cancelButton.hidden = false;
    passwordHint.textContent = "Leave blank to keep the current password.";
    form.password.required = false;
    return;
  }
  if (button.dataset.action === "disable") {
    const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: !user.disabled }),
    });
    const body = await response.json();
    message.textContent = response.ok ? (user.disabled ? "User enabled." : "User disabled.") : body.error;
    if (response.ok) await load();
    return;
  }
  if (button.dataset.action === "delete" && confirm(`Delete ${user.email}?`)) {
    const response = await fetch(`/api/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
    const body = await response.json();
    message.textContent = response.ok ? "User deleted." : body.error;
    if (response.ok) await load();
  }
});

function resetForm() {
  form.reset();
  form.elements.namedItem("id").value = "";
  title.textContent = "Add user";
  saveButton.textContent = "Add user";
  cancelButton.hidden = true;
  passwordHint.textContent = "At least 12 characters.";
  form.password.required = true;
  siteField.hidden = false;
}

function render() {
  const known = new Set(sites.map((site) => site.id));
  rows.innerHTML = users
    .map((user) => {
      const sitesLabel = user.fullAccess
        ? "Every site"
        : user.siteIds.map((id) => sites.find((site) => site.id === id)?.name || id).join(", ") || "No sites";
      const access = user.admin ? `Admin · ${sitesLabel}` : sitesLabel;
      return `<tr>
        <td>${escapeHtml(user.email)}</td>
        <td>${escapeHtml(access)}</td>
        <td>${user.disabled ? "Disabled" : "Active"}</td>
        <td class="header-links">
          <button type="button" data-action="edit" data-id="${escapeHtml(user.id)}">Edit</button>
          <button type="button" data-action="disable" data-id="${escapeHtml(user.id)}">${user.disabled ? "Enable" : "Disable"}</button>
          <button type="button" data-action="delete" data-id="${escapeHtml(user.id)}">Delete</button>
        </td>
      </tr>`;
    })
    .join("");
  const extra = users.flatMap((user) => user.siteIds.filter((id) => !known.has(id)));
  const options = [
    ...sites.map((site) => ({ id: site.id, name: site.name })),
    ...[...new Set(extra)].map((id) => ({ id, name: id })),
  ];
  const selected = new Set([...picks.querySelectorAll("input:checked")].map((input) => input.value));
  picks.innerHTML = options
    .map(
      (site) => `<label><input type="checkbox" value="${escapeHtml(site.id)}" ${selected.has(site.id) ? "checked" : ""} /> ${escapeHtml(site.name)}</label>`,
    )
    .join("");
}

async function load() {
  const response = await fetch("/api/users", { cache: "no-store" });
  if (response.status === 401) {
    location.href = "/login";
    return;
  }
  const body = await response.json();
  users = body.users || [];
  sites = body.sites || [];
  render();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

form.password.required = true;
await load();
