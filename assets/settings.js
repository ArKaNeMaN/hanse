const selects = document.querySelectorAll("[data-settings-driver]");

function syncDriverFields(select) {
  const form = select.closest("form");
  if (form === null) {
    return;
  }
  const driver = select.value;
  form.querySelectorAll("[data-driver-fields]").forEach((group) => {
    const name = group.getAttribute("data-driver-fields");
    group.hidden = name !== driver;
  });
}

selects.forEach((select) => {
  if (!(select instanceof HTMLSelectElement)) {
    return;
  }
  syncDriverFields(select);
  select.addEventListener("change", () => syncDriverFields(select));
});
