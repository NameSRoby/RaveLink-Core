/**
 * Feature task navigation.
 * Developer context and change constraints:
 * docs/DEVELOPMENT.md#request-security-and-the-feature-ui-relay
 */
function taskNavigation() {
  for (const workspace of document.querySelectorAll("[data-task-workspace]")) {
    const panels = [...workspace.querySelectorAll("[data-task-panel]")];
    const tasks = [...new Set(panels.map((panel) => panel.dataset.taskPanel))];
    if (!tasks.length) continue;
    const preferred = tasks.indexOf(workspace.dataset.defaultTask);
    if (preferred > 0) tasks.unshift(...tasks.splice(preferred, 1));
    const nav = document.createElement("nav");
    nav.className = "task-navigation";
    nav.setAttribute("aria-label", workspace.dataset.taskWorkspace);
    const select = (task) => {
      workspace.dataset.activeTask = task;
      for (const panel of panels)
        panel.classList.toggle("task-inactive", panel.dataset.taskPanel !== task);
      for (const button of nav.children)
        button.setAttribute("aria-pressed", String(button.dataset.task === task));
      workspace.dispatchEvent(new CustomEvent("task-change", { detail: task }));
    };
    for (const task of tasks) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.task = task;
      button.textContent = task;
      button.onclick = () => select(task);
      nav.append(button);
    }
    workspace.prepend(nav);
    workspace.selectTask = select;
    select(workspace.dataset.defaultTask || tasks[0]);
  }
}

const css = `.task-navigation{display:flex;flex-wrap:wrap;gap:6px;padding:12px 0;margin-bottom:12px;border-bottom:1px solid var(--edge,#293b60);grid-column:1/-1}
.task-navigation button{min-height:40px;padding:8px 16px;border-radius:8px}
.task-navigation button[aria-pressed=true]{background:var(--accent,#a90036)!important;color:var(--text,#fff);border-color:var(--accent,#a90036)}
.task-inactive{display:none!important}
[data-task-workspace]>.task-navigation{position:relative}
[data-task-workspace] .task-navigation:focus-within{outline-offset:3px}`;

module.exports = { taskNavigation, css };
