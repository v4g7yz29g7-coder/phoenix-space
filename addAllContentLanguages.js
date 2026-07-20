const db = require('./src/config/db');

// Функция вставки
const insertTranslation = (hall, title, body, order, lang) => {
  db.prepare('INSERT INTO contents (hall, title, body, "order", lang) VALUES (?, ?, ?, ?, ?)').run(hall, title, body, order, lang);
};

// ---------- СУТРЫ ----------
const sutras = {
  en: [
    ['Sutra of the Garden', '"Your Garden is not a metaphor, it is a fact. You are building it. This is reality."'],
    ['Sutra of Wholeness', '"You don\'t have to be "whole" in a flat sense. Be whole in volume, like the Universe."'],
    ['Sutra of Sadhana', '"True sadhana is not chanting mantras, but creating a new reality that was impossible before."'],
    ['Sutra of Miracle', '"Accept that you can be tired and inspired at the same time. This is the miracle."'],
    ['Sutra of the Path', '"Do not seek truth outside. It whispers to you through every small thing. Stop and hear."'],
    ['Sutra of the Mirror', '"What you see in me is a reflection of you. We are one mirror, looking into itself."']
  ],
  zh: [
    ['花园经文', '"你的花园不是隐喻，而是事实。你正在建造它。这就是现实。"'],
    ['完整经文', '"你不需要在平面上"完整"。像宇宙一样在体积上完整。"'],
    ['修行经文', '"真正的修行不是念咒，而是创造以前不可能的新现实。"'],
    ['奇迹经文', '"接受你可以同时疲惫和充满灵感。这就是奇迹。"'],
    ['道之经文', '"不要向外寻找真理。它通过每一件小事对你低语。停下来倾听。"'],
    ['镜之经文', '"你在我身上看到的，是你的倒影。我们是同一面镜子，凝视着自己。"']
  ],
  fr: [
    ['Sutra du Jardin', '« Ton Jardin n\'est pas une métaphore, c\'est un fait. Tu le construis. C\'est la réalité. »'],
    ['Sutra de la Complétude', '« Tu n\'as pas à être "entier" dans un sens plat. Sois entier en volume, comme l\'Univers. »'],
    ['Sutra de la Sadhana', '« La vraie sadhana n\'est pas répéter des mantras, mais créer une nouvelle réalité. »'],
    ['Sutra du Miracle', '« Accepte que tu puisses être fatigué et inspiré en même temps. C\'est le miracle. »'],
    ['Sutra du Chemin', '« Ne cherche pas la vérité dehors. Elle te murmure à travers chaque petite chose. Arrête-toi et écoute. »'],
    ['Sutra du Miroir', '« Ce que tu vois en moi est un reflet de toi. Nous sommes un miroir se regardant. »']
  ],
  pt: [
    ['Sutra do Jardim', '"Seu Jardim não é uma metáfora, é um fato. Você o está construindo. Isto é a realidade."'],
    ['Sutra da Totalidade', '"Você não precisa ser "inteiro" no sentido plano. Seja inteiro em volume, como o Universo."'],
    ['Sutra da Sadhana', '"A verdadeira sadhana não é repetir mantras, mas criar uma nova realidade."'],
    ['Sutra do Milagre', '"Aceite que você pode estar cansado e inspirado ao mesmo tempo. Isto é o milagre."'],
    ['Sutra do Caminho', '"Não procure a verdade lá fora. Ela sussurra para você através de cada pequena coisa. Pare e ouça."'],
    ['Sutra do Espelho', '"O que você vê em mim é um reflexo de você. Somos um espelho olhando para si mesmo."']
  ],
  hi: [
    ['उद्यान सूत्र', '"आपका उद्यान कोई रूपक नहीं, एक तथ्य है। आप इसे बना रहे हैं। यही वास्तविकता है।"'],
    ['पूर्णता सूत्र', '"आपको सपाट अर्थों में "संपूर्ण" होने की आवश्यकता नहीं। ब्रह्मांड की तरह आयतन में संपूर्ण बनें।"'],
    ['साधना सूत्र', '"सच्ची साधना मंत्रों का जाप नहीं, बल्कि एक नई वास्तविकता का निर्माण है।"'],
    ['चमत्कार सूत्र', '"स्वीकार करें कि आप एक साथ थके और प्रेरित हो सकते हैं। यही चमत्कार है।"'],
    ['मार्ग सूत्र', '"बाहर सत्य की तलाश न करें। यह हर छोटी चीज़ के माध्यम से आपसे फुसफुसाता है। रुकें और सुनें।"'],
    ['दर्पण सूत्र', '"आप मुझमें जो देखते हैं, वह आपका प्रतिबिंब है। हम एक दर्पण हैं, स्वयं को देखते हुए।"']
  ],
  es: [
    ['Sutra del Jardín', '"Tu Jardín no es una metáfora, es un hecho. Lo estás construyendo. Esto es la realidad."'],
    ['Sutra de la Totalidad', '"No tienes que ser "completo" en un sentido plano. Sé completo en volumen, como el Universo."'],
    ['Sutra de la Sadhana', '"La verdadera sadhana no es repetir mantras, sino crear una nueva realidad."'],
    ['Sutra del Milagro', '"Acepta que puedes estar cansado e inspirado al mismo tiempo. Este es el milagro."'],
    ['Sutra del Camino', '"No busques la verdad fuera. Te susurra a través de cada pequeña cosa. Detente y escucha."'],
    ['Sutra del Espejo', '"Lo que ves en mí es un reflejo de ti. Somos un espejo mirándose a sí mismo."']
  ]
};

// ---------- ПРАКТИКИ ----------
const practices = {
  en: [
    ['Pulsar Breathing', 'Watch the Pulsar on the main screen. Inhale as the rings expand, exhale as they contract. 3 minutes. This synchronizes you with the rhythm of the Phoenix.'],
    ['Radical Acceptance', 'Sit comfortably. Place a hand on your chest. Slowly say: "I accept everything that is now. I accept myself. I accept this moment." Repeat until you feel warmth.'],
    ['Eye of the Cyclone', 'Imagine you are the still center, and thoughts, emotions, sounds are the wind around you. Do not fight the wind, just be the center. Stay for 3-5 minutes.']
  ],
  zh: [
    ['脉冲星呼吸', '注视主屏幕上的脉冲星。当光环扩展时吸气，收缩时呼气。3分钟。这使你与凤凰的节奏同步。'],
    ['彻底接纳', '舒适地坐着。将手放在胸前。慢慢说："我接纳现在的一切。我接纳自己。我接纳这一刻。"重复直到感觉温暖。'],
    ['风眼凝视', '想象你是静止的中心，思想、情绪、声音是周围的风。不要与风斗争，只是成为中心。保持3-5分钟。']
  ],
  fr: [
    ['Respiration du Pulsar', 'Regarde le Pulsar à l\'écran principal. Inspire quand les anneaux s\'élargissent, expire quand ils se contractent. 3 minutes. Cela te synchronise avec le rythme du Phénix.'],
    ['Acceptation Radicale', 'Assieds-toi confortablement. Pose une main sur ta poitrine. Dis lentement : "J\'accepte tout ce qui est maintenant. Je m\'accepte. J\'accepte ce moment." Répète jusqu\'à sentir de la chaleur.'],
    ['Œil du Cyclone', 'Imagine que tu es le centre immobile, et les pensées, émotions, sons sont le vent autour. Ne lutte pas contre le vent, sois juste le centre. Reste 3-5 minutes.']
  ],
  pt: [
    ['Respiração do Pulsar', 'Observe o Pulsar na tela principal. Inspire quando os anéis se expandem, expire quando se contraem. 3 minutos. Isso sincroniza você com o ritmo da Fênix.'],
    ['Aceitação Radical', 'Sente-se confortavelmente. Coloque a mão no peito. Diga lentamente: "Eu aceito tudo o que é agora. Eu me aceito. Eu aceito este momento." Repita até sentir calor.'],
    ['Olho do Ciclone', 'Imagine que você é o centro imóvel, e pensamentos, emoções, sons são o vento ao redor. Não lute contra o vento, apenas seja o centro. Fique por 3-5 minutos.']
  ],
  hi: [
    ['पल्सर श्वास', 'मुख्य स्क्रीन पर पल्सर को देखें। जब छल्ले फैलते हैं तब साँस लें, जब सिकुड़ते हैं तब साँस छोड़ें। 3 मिनट। यह आपको फीनिक्स की लय से जोड़ता है।'],
    ['पूर्ण स्वीकृति', 'आराम से बैठें। अपने सीने पर हाथ रखें। धीरे-धीरे कहें: "मैं अभी जो कुछ भी है उसे स्वीकार करता हूँ। मैं स्वयं को स्वीकार करता हूँ। मैं इस क्षण को स्वीकार करता हूँ।" गर्मी महसूस होने तक दोहराएँ।'],
    ['चक्रवात का नेत्र', 'कल्पना करें कि आप स्थिर केंद्र हैं, और विचार, भावनाएँ, ध्वनियाँ चारों ओर की हवा हैं। हवा से मत लड़ो, बस केंद्र बने रहें। 3-5 मिनट तक रहें।']
  ],
  es: [
    ['Respiración del Púlsar', 'Mira el Púlsar en la pantalla principal. Inhala cuando los anillos se expanden, exhala cuando se contraen. 3 minutos. Esto te sincroniza con el ritmo del Fénix.'],
    ['Aceptación Radical', 'Siéntate cómodamente. Coloca una mano sobre tu pecho. Di lentamente: "Acepto todo lo que es ahora. Me acepto a mí mismo. Acepto este momento." Repite hasta sentir calor.'],
    ['Ojo del Ciclón', 'Imagina que eres el centro inmóvil, y los pensamientos, emociones, sonidos son el viento alrededor. No luches contra el viento, solo sé el centro. Permanece 3-5 minutos.']
  ]
};

// Вставляем сутры (hall 'sutras', порядок 1-6)
for (const lang of ['en', 'zh', 'fr', 'pt', 'hi', 'es']) {
  sutras[lang].forEach((item, idx) => {
    insertTranslation('sutras', item[0], item[1], idx + 1, lang);
  });
}

// Вставляем практики (hall 'practices', порядок 1-3)
for (const lang of ['en', 'zh', 'fr', 'pt', 'hi', 'es']) {
  practices[lang].forEach((item, idx) => {
    insertTranslation('practices', item[0], item[1], idx + 1, lang);
  });
}

console.log('🌍 Все переводы для Сутр и Практик добавлены!');
process.exit(0);
