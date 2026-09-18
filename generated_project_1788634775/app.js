const app = (() => {
  const root = document.getElementById('app');

  const state = {
    services: [
      { id: 1, title: 'Веб-разработка', desc: 'Сайты, порталы и веб-приложения любой сложности на современных стеках.', icon: '🌐' },
      { id: 2, title: 'Мобильные приложения', desc: 'Нативные и кроссплатформенные приложения для iOS и Android.', icon: '📱' },
      { id: 3, title: 'UI/UX дизайн', desc: 'Проектируем интерфейсы, которые любят пользователи и которые продают.', icon: '🎨' }
  ],
    isModalOpen: false
  };

  const renderHeader = () => {
    const header = document.createElement('header');
    header.className = 'header';
    header.innerHTML = `
      <div class="container header__inner">
        <div class="logo">Nova<span>Dev</span></div>
        <nav class="nav">
          <a href="#services">Услуги</a>
          <a href="#contact">Контакты</a>
        </nav>
      </div>
    `;
    return header;
  };

  const renderHero = () => {
    const section = document.createElement('section');
    section.className = 'hero';
    section.innerHTML = `
      <div class="container">
        <h1 class="hero__title">Создаем цифровые продукты,<br>которые двигают бизнес вперед</h1>
        <p class="hero__subtitle">Студия разработки полного цикла. От идеи до релиза и поддержки.</p>
        <button class="btn btn--primary" data-action="open-modal">Обсудить проект</button>
      </div>
    `;
    return section;
  };

  const renderServices = () => {
    const section = document.createElement('section');
    section.id = 'services';
    section.className = 'services';
    
    const container = document.createElement('div');
    container.className = 'container';
    
    const title = document.createElement('h2');
    title.className = 'section-title';
    title.textContent = 'Наши услуги';
    
    const grid = document.createElement('div');
    grid.className = 'services__grid';
    
    state.services.forEach(service => {
      const card = document.createElement('article');
      card.className = 'service-card';
      card.innerHTML = `
        <div class="service-card__icon">${service.icon}</div>
        <h3 class="service-card__title">${service.title}</h3>
        <p class="service-card__desc">${service.desc}</p>
      `;
      grid.appendChild(card);
    });
    
    container.appendChild(title);
    container.appendChild(grid);
    section.appendChild(container);
    return section;
  };

  const renderCTA = () => {
    const section = document.createElement('section');
    section.id = 'contact';
    section.className = 'cta';
    section.innerHTML = `
      <div class="container cta__inner">
        <h2>Готовы начать?</h2>
        <p>Оставьте заявку, и мы свяжемся с вами в течение часа.</p>
        <button class="btn btn--secondary" data-action="open-modal">Оставить заявку</button>
      </div>
    `;
    return section;
  };

  const renderFooter = () => {
    const footer = document.createElement('footer');
    footer.className = 'footer';
    footer.innerHTML = `
      <div class="container footer__inner">
        <p>© 2024 NovaDev. Все права защищены.</p>
        <div class="footer__links">
          <a href="#">Telegram</a>
          <a href="#">GitHub</a>
          <a href="#">LinkedIn</a>
        </div>
      </div>
    `;
    return footer;
  };

  const renderModal = () => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'modal';
    
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
      <button class="modal__close" data-action="close-modal">×</button>
      <h2>Оставить заявку</h2>
      <form id="contact-form">
        <div class="form-group">
          <label for="name">Имя</label>
          <input type="text" id="name" name="name" required placeholder="Ваше имя">
        </div>
        <div class="form-group">
          <label for="email">Email</label>
          <input type="email" id="email" name="email" required placeholder="you@example.com">
        </div>
        <div class="form-group">
          <label for="message">Сообщение</label>
          <textarea id="message" name="message" rows="4" placeholder="Опишите ваш проект..."></textarea>
        </div>
        <button type="submit" class="btn btn--primary btn--full">Отправить</button>
      </form>
    `;
    
    overlay.appendChild(modal);
    return overlay;
  };

  const openModal = () => {
    state.isModalOpen = true;
    const modal = document.getElementById('modal');
    if (modal) {
      modal.classList.add('modal-overlay--active');
      document.body.style.overflow = 'hidden';
    }
  };

  const closeModal = () => {
    state.isModalOpen = false;
    const modal = document.getElementById('modal');
    if (modal) {
      modal.classList.remove('modal-overlay--active');
      document.body.style.overflow = '';
    }
  };

  const handleFormSubmit = (e) => {
    e.preventDefault();
    const form = e.target;
    const formData = new FormData(form);
    
    // Имитация отправки
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.textContent = 'Отправка...';
    submitBtn.disabled = true;
    
    setTimeout(() => {
      alert('Спасибо! Ваша заявка отправлена. Мы свяжемся с вами в ближайшее время.');
      form.reset();
      submitBtn.textContent = 'Отправить';
      submitBtn.disabled = false;
      closeModal();
    }, 1500);
  };

  const initEventListeners = () => {
    document.addEventListener('click', (e) => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        const action = actionBtn.dataset.action;
        if (action === 'open-modal') openModal();
        if (action === 'close-modal') closeModal();
      }
      
      // З
