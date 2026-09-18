function getLayoutTemplate(name) {
  const templates = {
    'hero-grid': {
      columns: [2, 1],
      rows: 'auto',
      gap: 10,
      description: 'Крупный кадр + сетка'
    },
    'equal-cells': {
      columns: 3,
      gap: 10,
      description: 'Равные ячейки'
    },
    'ribbon': {
      direction: 'row',
      gap: 10,
      description: 'Лента'
    }
  };
  return templates[name] || templates['equal-cells'];
}
