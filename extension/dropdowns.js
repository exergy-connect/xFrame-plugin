// Render menus inside the extension page instead of Chrome's native select
// popup, so mouse events stay in the side panel.
const dropdownControls = [];

function syncDropdowns() {
  for (const control of dropdownControls) control.sync();
}

for (const select of document.querySelectorAll('select')) {
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = `${select.className} dropdown-trigger`;
  trigger.id = `${select.id}Button`;
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const label = document.querySelector(`label[for="${select.id}"]`);
  const labelText = select.getAttribute('aria-label') || label?.textContent.trim() || '';
  if (label) label.htmlFor = trigger.id;
  const menu = document.createElement('div');
  menu.id = `${select.id}Menu`;
  menu.className = 'dropdown-menu';
  menu.setAttribute('popover', 'auto');
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', labelText);
  trigger.setAttribute('aria-controls', menu.id);
  select.hidden = true;
  select.after(trigger);
  document.body.append(menu);

  function close(focus = false) {
    menu.hidePopover();
    trigger.setAttribute('aria-expanded', 'false');
    if (focus) trigger.focus();
  }

  function sync() {
    const text = select.selectedOptions[0]?.textContent || '';
    trigger.textContent = `${text} ▾`;
    trigger.setAttribute('aria-label', `${labelText}: ${text}`);
    trigger.disabled = select.disabled;
    if (select.disabled) close();
  }

  function open() {
    if (select.disabled) return;
    menu.replaceChildren();
    for (const option of select.options) {
      if (option.hidden || option.disabled) continue;
      const item = document.createElement('button');
      item.type = 'button';
      item.tabIndex = -1;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      item.textContent = option.textContent;
      item.addEventListener('click', () => {
        select.value = option.value;
        sync();
        close(true);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      menu.append(item);
    }
    const rect = trigger.getBoundingClientRect();
    menu.style.minWidth = `${rect.width}px`;
    menu.style.left = `${rect.left}px`;
    menu.style.top = `${rect.bottom + 3}px`;
    menu.showPopover();
    const { height, width } = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - width - 4))}px`;
    if (rect.bottom + height + 3 > window.innerHeight) {
      menu.style.top = `${Math.max(4, rect.top - height - 3)}px`;
    }
    trigger.setAttribute('aria-expanded', 'true');
    (menu.querySelector('[aria-selected="true"]') || menu.firstElementChild)?.focus();
  }

  trigger.addEventListener('click', () => {
    if (menu.matches(':popover-open')) close();
    else open();
  });
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      open();
    }
  });
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.children];
    const index = items.indexOf(document.activeElement);
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % items.length;
    if (event.key === 'ArrowUp') next = (index - 1 + items.length) % items.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = items.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      items[index]?.click();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      close(true);
    } else if (event.key === 'Tab') {
      close(true);
    }
  });
  menu.addEventListener('toggle', () => {
    trigger.setAttribute('aria-expanded', String(menu.matches(':popover-open')));
  });
  select.addEventListener('change', sync);
  new MutationObserver(sync).observe(select, {
    attributes: true, childList: true, subtree: true,
  });
  dropdownControls.push({ sync });
  sync();
}
