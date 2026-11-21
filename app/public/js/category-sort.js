// Drag-and-drop reordering for the category tree (roadmap Phase 10, optional).
// Progressive enhancement: the Up and Down buttons keep working without this
// file, and if SortableJS cannot be loaded nothing changes. Each list holds the
// siblings of one parent, so a drag can only reorder within its own level.
// A drop fills the hidden form and submits it: the server does the work, then
// redirects back, so the page always shows what was saved.

const form = document.getElementById('place-form');

async function enable() {
  const { default: Sortable } = await import('/vendor/sortablejs/sortable.esm.js');

  for (const handle of document.querySelectorAll('.drag-handle')) handle.hidden = false;

  for (const list of document.querySelectorAll('[data-sortable]')) {
    Sortable.create(list, {
      draggable: '.cat-item',
      handle: '.drag-handle',
      animation: 150,
      onEnd(event) {
        if (event.oldIndex === event.newIndex) return;
        form.action = `/admin/categories/${encodeURIComponent(event.item.dataset.id)}/place`;
        form.elements.position.value = String(event.newIndex + 1);
        form.submit();
      },
    });
  }
}

if (form) enable().catch(() => {});
