/** Pack complete automatic rows so tall faders cannot overlap fullscreen screens. */
export function deckScreens(items, columns, room, gap) {
  const rows = [];
  let row = [];
  const end = () => {
    if (row.length) {
      rows.push(row);
      row = [];
    }
  };
  for (const item of items) {
    row.push(item);
    if (row.length >= columns) end();
  }
  end();
  const screens = [[]];
  let height = 0;
  for (const line of rows) {
    const size = Math.max(...line.map((item) => item.height));
    if (height && height + gap + size > room) {
      screens.push([]);
      height = 0;
    }
    screens.at(-1).push(...line.map((item) => item.element));
    height += (height ? gap : 0) + size;
  }
  return screens;
}
