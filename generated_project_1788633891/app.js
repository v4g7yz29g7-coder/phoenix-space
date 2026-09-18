const services = [
  {
    title: 'Веб-разработка',
    description: 'Создаём сайты и веб-приложения любой сложности: от лендингов до корпоративных порталов и интернет-магазинов.',
    icon: '🌐'
  },
  {
    title: 'Мобильные приложения',
    description: 'Разрабатываем нативные и кроссплатформенные приложения для iOS и Android с фокусом на UX и производительность.',
    icon: '📱'
  },
  {
    title: 'UI/UX дизайн',
    description: 'Проектируем интерфейсы, которые нравятся пользователям и решают бизнес-задачи. Прототипы, дизайн-системы, анимация.',
    icon: '🎨'
  }
];

const app = document.getElementById('app');

app.innerHTML = `
  <header class="hero">
    <h1>Студия разработки <span class="accent">CodeForge</span></h1>
    <p class="subtitle">Создаём цифровые продукты, которые двигают бизнес вперёд</p>
  </header>
  
  <section class="services">
    ${services.map((service, index) => `
      <div class="service-card" style="--delay: ${index * 0.15}s">
        <div class="service-icon">${service.icon}</div>
        <h3>${service.title}</h3>
        <p>${service.description}</p>
      </div>
    `).join('')}
  </section>
  
  <section class="cta-section">
    <button class="cta-button" id="requestBtn">Оставить заявку</button>
  </section>
  
  <div class="modal-overlay" id="modalOverlay">
    <div class="modal">
      <button class="modal-close" id="modalClose">×</button>
      <h2>Оставьте заявку</h2>
      <form id="requestForm">
        <input type="text" placeholder="Ваше имя" required>
        <input type="email" placeholder="Email" required>
        <textarea placeholder="Опишите ваш проект" rows="4" required></textarea>
        <button type="submit" class="submit-btn">Отправить</button>
      </form>
    </div>
  </div>
`;

// Стили добавляем динамически
const style = document.createElement('style');
style.textContent = `
  * {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
  }
  
  body {
    font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
    background: #0a0a0f;
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    justify-content: center;
    align-items: center;
    overflow-x: hidden;
  }
  
  #app {
    max-width: 1200px;
    width: 100%;
    padding: 40px 20px;
    text-align: center;
  }
  
  .hero {
    margin-bottom: 60px;
    animation: fadeInUp 0.8s ease;
  }
  
  .hero h1 {
    font-size: 3.5rem;
    font-weight: 800;
    margin-bottom: 20px;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
  }
  
  .accent {
    color: #667eea;
  }
  
  .subtitle {
    font-size: 1.3rem;
    color: #a0a0a0;
    max-width: 600px;
    margin: 0 auto;
  }
  
  .services {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
    gap: 30px;
    margin-bottom: 60px;
  }
  
  .service-card {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 16px;
    padding: 40px 30px;
    transition: all 0.3s ease;
    animation: fadeInUp 0.8s ease forwards;
    opacity: 0;
    animation-delay: var(--delay);
  }
  
  .service-card:hover {
    transform: translateY(-10px);
    border-color: #667eea;
    box-shadow: 0 20px 40px rgba(102, 126, 234, 0.15);
  }
  
  .service-icon {
    font-size: 3rem;
    margin-bottom: 20px;
  }
  
  .service-card h3 {
    font-size: 1.5rem;
    margin-bottom: 15px;
    color: #ffffff;
  }
  
  .service-card p {
    color: #b0b0b0;
    line-height: 1.6;
  }
  
  .cta-section {
    margin-top: 40px;
  }
  
  .cta-button {
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    padding: 18px 50px;
    font-size: 1.2rem;
    font-weight: 600;
    border-radius: 50px;
    cursor: pointer;
    transition: all 0.3s ease;
    box-shadow: 0 10px 30px rgba(102, 126, 234, 0.3);
  }
  
  .cta-button:hover {
    transform: translateY(-3px);
    box-shadow: 0 15px 40px rgba(102, 126, 234, 0.4);
  }
  
  .modal-overlay {
    display: none;
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(5px);
    justify-content: center;
    align-items: center;
    z-index: 1000;
  }
  
  .modal-overlay.active {
    display: flex;
    animation: fadeIn 0.3s ease;
  }
  
  .modal {
    background: #1a1a2e;
    border: 1px solid #2a2a4a;
    border-radius: 20px;
    padding:
