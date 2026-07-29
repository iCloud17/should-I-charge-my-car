// Reusable custom-listbox dropdown: a trigger button plus a <ul> of options,
// with open/close, single-open coordination, outside-click close, and keyboard
// navigation. This is the currency/units picker pattern factored out so every
// fixed-list dropdown (currency, units, the hr/min tier unit) looks and behaves
// the same, and a new one is a few lines to wire up.

const openMenus = new Set(); // open instances, so opening one closes the rest

export function createDropdown({
  trigger,
  menu,
  itemClass = "",
  options,
  getValue,
  onChange,
  renderItem = (li, opt) => { li.textContent = opt.label; },
  optionValue = (opt) => opt.value,
}) {
  const btn = typeof trigger === "string" ? document.getElementById(trigger) : trigger;
  const ul = typeof menu === "string" ? document.getElementById(menu) : menu;

  function render() {
    ul.innerHTML = "";
    const current = getValue();
    for (const opt of options()) {
      const li = document.createElement("li");
      li.className = `combo__item ${itemClass}`.trim();
      li.dataset.value = optionValue(opt);
      li.setAttribute("role", "option");
      li.setAttribute("tabindex", "-1");
      li.setAttribute("aria-selected", optionValue(opt) === current ? "true" : "false");
      renderItem(li, opt);
      ul.appendChild(li);
    }
  }

  function open() {
    for (const other of [...openMenus]) if (other !== api) other.close();
    render();
    ul.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    openMenus.add(api);
    const active = ul.querySelector('[aria-selected="true"]') || ul.querySelector(".combo__item");
    if (active) active.focus();
  }

  function close() {
    ul.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    openMenus.delete(api);
  }

  function choose(li) {
    if (!li) return;
    close();
    btn.focus();
    onChange(li.dataset.value);
  }

  btn.addEventListener("click", () => {
    if (btn.getAttribute("aria-expanded") === "true") close();
    else open();
  });
  // mousedown + preventDefault selects before any focus/blur race can close us.
  ul.addEventListener("mousedown", (e) => {
    const li = e.target.closest(".combo__item");
    if (!li) return;
    e.preventDefault();
    choose(li);
  });

  const api = { open, close, render, choose, menu: ul, trigger: btn };
  return api;
}

// One document-level outside-click + keyboard handler shared by every dropdown.
document.addEventListener("click", (e) => {
  for (const d of [...openMenus]) {
    if (!d.menu.contains(e.target) && !d.trigger.contains(e.target)) d.close();
  }
});
document.addEventListener("keydown", (e) => {
  const d = [...openMenus].at(-1);
  if (!d) return;
  const items = [...d.menu.querySelectorAll(".combo__item")];
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement);
  if (e.key === "Escape") { d.close(); d.trigger.focus(); }
  else if (e.key === "ArrowDown") { e.preventDefault(); (items[idx + 1] || items[0]).focus(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); (items[idx - 1] || items[items.length - 1]).focus(); }
  else if ((e.key === "Enter" || e.key === " ") && idx >= 0) { e.preventDefault(); d.choose(items[idx]); }
});
