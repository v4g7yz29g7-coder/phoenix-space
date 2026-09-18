const app = (() => {
  const state = {
    isModalOpen: false,
    isFormSubmitting: false,
  };

  const elements = {
    modal: null,
    modalOverlay: null,
    modalContent: null,
    closeModalBtn: null,
    form: null,
    submitBtn: null,
    requestBtn: null,
    successMessage: null,
  };

  const init = () => {
    cacheDom();
    bindEvents();
    createModal();
  };

  const cacheDom = () => {
    elements.requestBtn = document.querySelector('[data-action="open-modal"]');
  };

  const bindEvents = () => {
    if (elements.requestBtn) {
      elements.requestBtn.addEventListener('click', openModal);
    }
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.isModalOpen) {
        closeModal();
      }
    });
  };

  const createModal = () => {
    elements.modalOverlay = document.createElement('div');
    elements.modalOverlay.className = 'modal-overlay';
    elements.modalOverlay.setAttribute('aria-hidden', 'true');

    elements.modal = document.createElement('div');
    elements.modal.className = 'modal';
    elements.modal.setAttribute('role', 'dialog');
    elements.modal.setAttribute('aria-modal', 'true');
    elements.modal.setAttribute('aria-labelledby', 'modal-title');

    elements.modalContent = document.createElement('div');
    elements.modalContent.className = 'modal-content';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'modal-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.setAttribute('aria-label', 'Закрыть окно');
    closeBtn.addEventListener('click', closeModal);
    elements.closeModalBtn = closeBtn;

    const title = document.createElement('h2');
    title.id = 'modal-title';
    title.textContent = 'Оставьте заявку';

    const subtitle = document.createElement('p');
    subtitle.className = 'modal-subtitle';
    subtitle.textContent = 'Мы свяжемся с вами в течение 15 минут';

    elements.form = document.createElement('form');
    elements.form.className = 'modal-form';
    elements.form.setAttribute('novalidate', '');

    const nameLabel = document.createElement('label');
    nameLabel.setAttribute('for', 'name');
    nameLabel.textContent = 'Ваше имя';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'name';
    nameInput.name = 'name';
    nameInput.placeholder = 'Иван';
    nameInput.required = true;

    const phoneLabel = document.createElement('label');
    phoneLabel.setAttribute('for', 'phone');
    phoneLabel.textContent = 'Телефон';

    const phoneInput = document.createElement('input');
    phoneInput.type = 'tel';
    phoneInput.id = 'phone';
    phoneInput.name = 'phone';
    phoneInput.placeholder = '+7 (___) ___-__-__';
    phoneInput.required = true;

    const commentLabel = document.createElement('label');
    commentLabel.setAttribute('for', 'comment');
    commentLabel.textContent = 'Комментарий';

    const commentTextarea = document.createElement('textarea');
    commentTextarea.id = 'comment';
    commentTextarea.name = 'comment';
    commentTextarea.rows = 3;
    commentTextarea.placeholder = 'Расскажите о вашем проекте';

    elements.submitBtn = document.createElement('button');
    elements.submitBtn.type = 'submit';
    elements.submitBtn.className = 'btn btn-primary btn-full';
    elements.submitBtn.textContent = 'Отправить заявку';

    elements.form.appendChild(nameLabel);
    elements.form.appendChild(nameInput);
    elements.form.appendChild(phoneLabel);
    elements.form.appendChild(phoneInput);
    elements.form.appendChild(commentLabel);
    elements.form.appendChild(commentTextarea);
    elements.form.appendChild(elements.submitBtn);

    elements.successMessage = document.createElement('div');
    elements.successMessage.className = 'success-message';
    elements.successMessage.style.display = 'none';
    elements.successMessage.innerHTML = '<p>Спасибо! Ваша заявка отправлена.</p>';

    elements.modalContent.appendChild(closeBtn);
    elements.modalContent.appendChild(title);
    elements.modalContent.appendChild(subtitle);
    elements.modalContent.appendChild(elements.form);
    elements.modalContent.appendChild(elements.successMessage);

    elements.modal.appendChild(elements.modalContent);
    elements.modalOverlay.appendChild(elements.modal);
    document.body.appendChild(elements.modalOverlay);

    elements.form.addEventListener('submit', handleFormSubmit);
    elements.modalOverlay.addEventListener('click', (e) => {
      if (e.target === elements.modalOverlay) {
        closeModal();
      }
    });
  };

  const openModal = () => {
    if (!elements.modalOverlay) return;
    state.isModalOpen = true;
    elements.modalOverlay.classList.add('active');
    elements.modalOverlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    const firstInput = elements.form.querySelector('input');
    if (firstInput) {
      setTimeout(() => firstInput.focus(), 100);
    }
  };

  const closeModal = () => {
    if (!elements.modalOverlay) return;
    state.isModalOpen = false;
    elements.modalOverlay.classList.remove('active');
    elements.modalOverlay.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
    resetForm();
  };

  const resetForm = () => {
    if (!elements.form) return;
    elements.form.reset();
    elements.form.style.display = 'block';
    elements.successMessage.style.display = 'none';
    state.isFormSubmitting = false;
    elements.submitBtn.disabled = false;
    elements.submitBtn.textContent = 'Отправить заявку';
  };

  const handleFormSubmit = (e) => {
    e.preventDefault();
    if (state.isFormSubmitting) return;

    const formData = new FormData(elements.form);
    const name = formData.get('name').trim();
    const phone = formData.get('phone').trim();
    const comment = formData.get('comment').trim();

    if (!validateForm(name, phone)) {
      return;
    }

    state.isFormSubmitting = true;
    elements.submitBtn.disabled = true;
    elements.submitBtn.textContent = 'Отправка...';

    // Имитация отправки на сервер
    setTimeout(() => {
      console.log('Отправка данных:', { name, phone, comment });
      elements.form.style.display = 'none';
      elements.successMessage.style.display = 'block';
      state.isFormSubmitting = false;
      elements.submitBtn.disabled = false;
      elements.submitBtn.textContent = '
