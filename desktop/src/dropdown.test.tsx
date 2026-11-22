import { beforeEach, expect, test } from "vitest";
import { fireEvent } from "@testing-library/dom";
import { closeOpenDropdown, enhanceSelect, justClosedByEscape } from "./dropdown";

function mount(options = ["不指定时间", "0 点", "1 点", "2 点", "3 点", "4 点", "5 点", "6 点", "7 点"]) {
  document.body.innerHTML = `<label>几点<select id="s">${options.map((text, index) => `<option value="${index === 0 ? "" : index}">${text}</option>`).join("")}</select></label><button id="outside">别处</button>`;
  const select = document.getElementById("s") as HTMLSelectElement;
  const dropdown = enhanceSelect(select);
  const button = document.querySelector<HTMLButtonElement>(".dd-btn")!;
  const list = document.querySelector<HTMLElement>(".dd-list")!;
  return { select, dropdown, button, list, changes: () => changes };
}
let changes = 0;
beforeEach(() => { changes = 0; });

test("the select stays as the data source; a button shows its current text and the list opens right under it", () => {
  const { select, button, list } = mount();
  select.addEventListener("change", () => { changes += 1; });
  expect(select.getAttribute("aria-hidden")).toBe("true");
  expect(button.textContent).toBe("不指定时间");
  expect(button.dataset.empty).toBe("true");
  expect(list.hidden).toBe(true);
  fireEvent.click(button);
  expect(list.hidden).toBe(false);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(list.querySelectorAll("li")).toHaveLength(9);
  // 最多露 6 行（6 × 32 + 内边距），宽度跟按钮一样，多的在里面滚。
  expect(list.style.maxHeight).toBe("200px");
  expect(list.style.width).toBe(`${button.getBoundingClientRect().width}px`);
  fireEvent.click(list.querySelectorAll("li")[3]!);
  expect(select.value).toBe("3");
  expect(button.textContent).toBe("2 点");
  expect(list.hidden).toBe(true);
  expect(changes).toBe(1);
});

test("keyboard: arrows open and move, Enter chooses, Esc closes only the dropdown and says so", () => {
  const { select, button, list } = mount();
  select.addEventListener("change", () => { changes += 1; });
  button.focus();
  fireEvent.keyDown(button, { key: "ArrowDown" });
  expect(list.hidden).toBe(false);
  fireEvent.keyDown(button, { key: "ArrowDown" });
  fireEvent.keyDown(button, { key: "ArrowDown" });
  fireEvent.keyDown(button, { key: "Enter" });
  expect(select.value).toBe("2");
  expect(changes).toBe(1);
  fireEvent.keyDown(button, { key: "ArrowUp" });
  expect(list.hidden).toBe(false);
  fireEvent.keyDown(button, { key: "Escape" });
  expect(list.hidden).toBe(true);
  expect(justClosedByEscape()).toBe(true);
  expect(select.value).toBe("2");
});

test("typing a digit jumps to the option starting with it", () => {
  const { select, button } = mount();
  button.focus();
  fireEvent.keyDown(button, { key: "5" });
  expect(select.options[select.selectedIndex]!.textContent).toBe("5 点");
});

test("disabled options cannot be chosen and a disabled select disables the button after sync()", () => {
  const { select, dropdown, button, list } = mount(["默认", "提前 15 分钟", "提前 1 小时"]);
  select.options[1]!.disabled = true;
  fireEvent.click(button);
  fireEvent.click(list.querySelectorAll("li")[1]!);
  expect(select.value).toBe("");
  expect(list.hidden).toBe(false);
  expect(list.querySelectorAll("li")[1]!.getAttribute("aria-disabled")).toBe("true");
  fireEvent.keyDown(button, { key: "ArrowDown" });
  fireEvent.keyDown(button, { key: "Enter" });
  expect(select.value).toBe("2"); // 方向键跳过不能选的那一项
  select.disabled = true;
  select.value = "";
  dropdown.sync();
  expect(button.disabled).toBe(true);
  expect(button.textContent).toBe("默认");
  fireEvent.click(button);
  expect(list.hidden).toBe(true);
});

test("clicking elsewhere closes it, only one dropdown is open at a time, and rebuilt options update the button", async () => {
  const { select, button, list } = mount();
  fireEvent.click(button);
  expect(list.hidden).toBe(false);
  fireEvent.pointerDown(document.getElementById("outside")!);
  expect(list.hidden).toBe(true);
  fireEvent.click(button);
  expect(closeOpenDropdown()).toBe(true);
  expect(closeOpenDropdown()).toBe(false);
  select.innerHTML = '<option value="a">换了一批</option>';
  await Promise.resolve();
  expect(button.textContent).toBe("换了一批");
});
