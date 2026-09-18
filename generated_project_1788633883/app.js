const services = [
  {
    title: 'Веб-приложения',
    description: 'Сложные SPA и PWA с высокой производительностью и современным стеком.',
    icon: '⚡'
  },
  {
    title: 'Мобильная разработка',
    description: 'Кроссплатформенные приложения для iOS и Android с нативным UX.',
    icon: '📱'
  },
  {
    title: 'UI/UX дизайн',
    description: 'Прототипирование, дизайн-системы и пользовательские интерфейсы.',
    icon: '🎨'
  }
];

const app = document.getElementById('app');

app.innerHTML = `
  <header class="hero">
    <h1>Студия разработки <span class="accent">Nexus</span></h1>
    <p class="subtitle">Создаём цифровые продукты, которые решают бизнес-задачи</p>
  </header>
  <section class="services">
    ${services.map((service, index) => `
      <div class="service-card" style="animation-delay: ${index * 0.15}s">
        <div class="service-icon">${service.icon}</div>
        <h3>${service.title}</h3>
        <p>${service.description}</p>
      </div>
    `).join('')}
  </section>
  <div class="cta-wrapper">
    <button class="cta-button" id="ctaButton">Оставить заявку</button>
  </div>
`;

const ctaButton = document.getElementById('ctaButton');

ctaButton.addEventListener('click', () => {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal">
      <button class="modal-close" aria-label="Закрыть">&times;</button>
      <h2>Оставьте заявку</h2>
      <form id="contactForm">
        <input type="text" placeholder="Ваше имя" required>
        <input type="email" placeholder="Email" required>
        <textarea placeholder="Опишите ваш проект" rows="4" required></textarea>
        <button type="submit" class="submit-btn">Отправить</button>
      </form>
    </div>
  `;
  document.body.appendChild(modal);

  const closeModal = () => modal.remove();
  modal.querySelector('.modal-close').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  modal.querySelector('#contactForm').addEventListener('submit', (e) => {
    e.preventDefault();
    modal.innerHTML = `
      <div class="modal success">
        <div class="success-icon">✓</div>
        <h2>Заявка отправлена!</h2>
        <p>Мы свяжемся с вами в ближайшее время.</p>
        <button class="submit-btn" onclick="this.closest('.modal-overlay').remove()">Закрыть</button>
      </div>
    `;
  });
});
