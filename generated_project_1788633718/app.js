const services = [
  {
    icon: '🚀',
    title: 'Веб-разработка',
    description: 'Создаём быстрые и адаптивные сайты любой сложности — от лендингов до корпоративных порталов.',
    features: ['React / Vue', 'Node.js', 'UI/UX дизайн']
  },
  {
    icon: '📱',
    title: 'Мобильные приложения',
    description: 'Нативные и кроссплатформенные приложения для iOS и Android с безупречным UX.',
    features: ['React Native', 'Flutter', 'App Store / Google Play']
  },
  {
    icon: '⚙️',
    title: 'Автоматизация и API',
    description: 'Интеграции, боты, CRM-системы и сложная бизнес-логика для роста вашего продукта.',
    features: ['REST / GraphQL', 'Telegram / Slack боты', 'Облачные решения']
  }
];

const app = document.getElementById('app');

app.innerHTML = `
  <header class="hero">
    <div class="hero-content">
      <h1 class="hero-title">Создаём цифровые продукты, которые работают на вас</h1>
      <p class="hero-subtitle">Студия разработки полного цикла — от идеи до запуска и поддержки</p>
      <button class="cta-button" id="ctaButton">Обсудить проект</button>
    </div>
  </header>

  <section class="services">
    <h2 class="section-title">Наши услуги</h2>
    <div class="services-grid">
      ${services.map((service, index) => `
        <div class="service-card" data-index="${index}">
          <div class="service-icon">${service.icon}</div>
          <h3 class="service-title">${service.title}</h3>
          <p class="service-description">${service.description}</p>
          <ul class="service-features">
            ${service.features.map(feature => `<li>${feature}</li>`).join('')}
          </ul>
        </div>
      `).join('')}
    </div>
  </section>

  <div class="modal-overlay" id="modalOverlay">
    <div class="modal">
      <button class="modal-close" id="modalClose">×</button>
      <h2 class="modal-title">Оставьте заявку</h2>
      <p class="modal-subtitle">Мы свяжемся с вами в течение 24 часов</p>
      <form id="contactForm" class="contact-form">
        <input type="text" placeholder="Ваше имя" required>
        <input type="email" placeholder="Email" required>
        <input type="tel" placeholder="Телефон" required>
        <textarea placeholder="Опишите ваш проект" rows="4"></textarea>
        <button type="submit" class="submit-button">Отправить заявку</button>
      </form>
    </div>
  </div>
`;

// Анимация появления карточек при скролле
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
    }
  });
}, { threshold: 0.2 });

document.querySelectorAll('.service-card').forEach(card => {
  observer.observe(card);
});

// Модальное окно
const modalOverlay = document.getElementById('modalOverlay');
const ctaButton = document.getElementById('ctaButton');
const modalClose = document.getElementById('modalClose');

ctaButton.addEventListener('click', () => {
  modalOverlay.classList.add('active');
  document.body.style.overflow = 'hidden';
});

modalClose.addEventListener('click', () => {
  modalOverlay.classList.remove('active');
  document.body.style.overflow = '';
});

modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) {
    modalOverlay.classList.remove('active');
    document.body.style.overflow = '';
  }
});

// Обработка формы
const contactForm = document.getElementById('contactForm');
contactForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const formData = new FormData(contactForm);
  const data = Object.fromEntries(formData);
  
  // Имитация отправки
  const submitButton = contactForm.querySelector('.submit-button');
  submitButton.textContent = 'Отправляем...';
  submitButton.disabled = true;
  
  setTimeout(() => {
    submitButton.textContent = '✓ Заявка отправлена!';
    submitButton.style.background = '#4CAF50';
    
    setTimeout(() => {
      modalOverlay.classList.remove('active');
      document.body.style.overflow = '';
      contactForm.reset();
      submitButton.textContent = 'Отправить заявку';
      submitButton.disabled = false;
      submitButton.style.background = '';
    }, 2000);
  }, 1500);
});

// Плавный скролл к услугам
document.querySelector('.hero-title').addEventListener('click', () => {
  document.querySelector('.services').scrollIntoView({ behavior: 'smooth' });
});
