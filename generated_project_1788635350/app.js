const services = [
  {
    icon: "🚀",
    title: "Веб-приложения",
    description: "Сложные SPA и PWA с высокой производительностью и современным стеком."
  },
  {
    icon: "🎨",
    title: "UI/UX дизайн",
    description: "Проектируем интерфейсы, которые продают и удерживают внимание."
  },
  {
    icon: "⚙️",
    title: "API и интеграции",
    description: "Надёжные бэкенд-решения и интеграции с внешними сервисами."
  }
];

const app = document.getElementById("app");

app.innerHTML = `
  <section class="hero">
    <h1>Создаём цифровые продукты, которые работают</h1>
    <p>Студия разработки полного цикла — от идеи до запуска и поддержки.</p>
    <button class="cta-btn" id="ctaBtn">Оставить заявку</button>
  </section>
  <section class="services">
    ${services.map(s => `
      <div class="service-card">
        <div class="service-icon">${s.icon}</div>
        <h3>${s.title}</h3>
        <p>${s.description}</p>
      </div>
    `).join("")}
  </section>
  <div class="modal-overlay" id="modalOverlay">
    <div class="modal">
      <h2>Заявка на проект</h2>
      <form id="requestForm">
        <input type="text" placeholder="Ваше имя" required>
        <input type="email" placeholder="Email" required>
        <textarea placeholder="Опишите задачу" rows="4" required></textarea>
        <button type="submit">Отправить</button>
      </form>
      <button class="close-modal" id="closeModal">✕</button>
    </div>
  </div>
`;

const ctaBtn = document.getElementById("ctaBtn");
const modalOverlay = document.getElementById("modalOverlay");
const closeModal = document.getElementById("closeModal");
const requestForm = document.getElementById("requestForm");

ctaBtn.addEventListener("click", () => {
  modalOverlay.classList.add("active");
});

closeModal.addEventListener("click", () => {
  modalOverlay.classList.remove("active");
});

modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) {
    modalOverlay.classList.remove("active");
  }
});

requestForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const formData = new FormData(requestForm);
  const data = Object.fromEntries(formData.entries());
  console.log("Заявка отправлена:", data);
  alert("Спасибо! Мы свяжемся с вами в ближайшее время.");
  modalOverlay.classList.remove("active");
  requestForm.reset();
});
