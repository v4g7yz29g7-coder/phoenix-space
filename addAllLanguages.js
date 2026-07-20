const db = require('./src/config/db');

// Функция вставки перевода
const insertTranslation = (hall, title, body, order, lang) => {
  db.prepare('INSERT INTO contents (hall, title, body, "order", lang) VALUES (?, ?, ?, ?, ?)').run(hall, title, body, order, lang);
};

// Переводы для "Шести Врат"
const gates = {
  en: [
    ['1. Reality', 'Everything you feel right now is the only reality. Don\'t run into past or future thoughts. Notice your breath, sounds, body sensations. This is the gate to freedom from illusions.\n\n💎 Tip: Stop for a minute, look around and say: "This is my life. It\'s real."'],
    ['2. Ambivalence', 'You can be angry and loving at the same time. This is not a contradiction — it is fullness. Allow yourself to be complex, unpolished, alive. Don\'t demand clarity.\n\n💎 Tip: Think of a person you have mixed feelings about and wish them well without suppressing your resentment.'],
    ['3. Paradox', 'Truth is almost always paradoxical. The more you give, the richer you become. The deeper you let go, the stronger you acquire. Trust contradictions.\n\n💎 Today: Find one paradox in your life and smile at it.'],
    ['4. Transgression', 'Step beyond familiar boundaries. Not destruction, but creation of the new. Do what you have never done: compliment a stranger, write a poem, take a different route.\n\n💎 Task: Perform a small act of courage today.'],
    ['5. Radicalism', 'Not half-measures. Say to yourself: "I will never betray my depth again." A quiet, unwavering determination to be yourself to the end.\n\n💎 Practice: Say this phrase aloud in front of a mirror.'],
    ['6. Naturalness', 'You don\'t have to try. You are already enough. Relax your shoulders, exhale, allow yourself to be as you are. This is awakening.\n\n💎 Affirmation: "I allow myself to be. Right now."']
  ],
  zh: [
    ['1. 现实', '你现在感受到的一切就是唯一的现实。不要逃入过去或未来的思绪中。注意呼吸、声音、身体的感觉。这是通往自由的大门。\n\n💎 提示：停下一分钟，环顾四周，说："这就是我的生活。它是真实的。"'],
    ['2. 矛盾并存', '你可以同时感到愤怒和爱。这不是矛盾——而是完整。允许自己复杂、不完美、鲜活。不要要求自己非此即彼。\n\n💎 提示：想起一个让你有复杂情绪的人，祝愿他们安好，同时不压抑你的怨恨。'],
    ['3. 悖论', '真理几乎总是矛盾的。你给予越多，就越富有。你放手越深，就越坚强。信任矛盾。\n\n💎 今天：在生活中找到一个悖论，对它微笑。'],
    ['4. 越界', '超越熟悉的界限。不是破坏，而是创造新事物。做你从未做过的事：赞美陌生人、写首诗、走不同的路。\n\n💎 任务：今天完成一个小小勇气之举。'],
    ['5. 激进', '不再半途而废。对自己说："我再也不背叛自己的深度。" 一种安静、不可动摇的决心，做自己到底。\n\n💎 练习：在镜子前大声说出这句话。'],
    ['6. 自然', '你无需努力。你已经足够。放松肩膀，呼气，允许自己如你所是。这就是觉醒。\n\n💎 肯定："我允许自己存在。就在此刻。"']
  ],
  fr: [
    ['1. Réalité', 'Tout ce que tu ressens maintenant est la seule réalité. Ne fuis pas dans les pensées du passé ou du futur. Remarque ta respiration, les sons, les sensations corporelles. C\'est la porte de la liberté.\n\n💎 Conseil : Arrête-toi une minute, regarde autour de toi et dis : "C\'est ma vie. Elle est réelle."'],
    ['2. Ambivalence', 'Tu peux être en colère et aimant en même temps. Ce n\'est pas une contradiction — c\'est la plénitude. Permets-toi d\'être complexe, imparfait, vivant.\n\n💎 Pense à une personne pour qui tu as des sentiments mitigés et souhaite-lui du bien sans réprimer ton ressentiment.'],
    ['3. Paradoxe', 'La vérité est presque toujours paradoxale. Plus tu donnes, plus tu deviens riche. Plus tu lâches prise, plus tu obtiens. Fais confiance aux contradictions.\n\n💎 Aujourd\'hui : trouve un paradoxe dans ta vie et souris-lui.'],
    ['4. Transgression', 'Sors des limites habituelles. Pas de destruction, mais de la création. Fais ce que tu n\'as jamais fait : complimente un inconnu, écris un poème, prends un autre chemin.\n\n💎 Tâche : accomplis un petit acte de courage aujourd\'hui.'],
    ['5. Radicalisme', 'Pas de demi-mesures. Dis-toi : "Je ne trahirai plus jamais ma profondeur." Une détermination tranquille et inébranlable à être toi-même.\n\n💎 Pratique : prononce cette phrase à voix haute devant un miroir.'],
    ['6. Naturel', 'Tu n\'as pas à faire d\'efforts. Tu es déjà assez. Relâche tes épaules, expire, permets-toi d\'être tel que tu es. C\'est l\'éveil.\n\n💎 Affirmation : "Je me permets d\'être. Ici et maintenant."']
  ],
  pt: [
    ['1. Realidade', 'Tudo o que você sente agora é a única realidade. Não fuja para pensamentos do passado ou do futuro. Observe sua respiração, sons, sensações corporais. Este é o portal para a liberdade.\n\n💎 Dica: Pare por um minuto, olhe ao redor e diga: "Esta é a minha vida. Ela é real."'],
    ['2. Ambivalência', 'Você pode estar com raiva e amor ao mesmo tempo. Isso não é contradição — é plenitude. Permita-se ser complexo, não polido, vivo.\n\n💎 Pense em alguém por quem você tem sentimentos mistos e deseje-lhe bem sem suprimir seu ressentimento.'],
    ['3. Paradoxo', 'A verdade é quase sempre paradoxal. Quanto mais você dá, mais rico se torna. Quanto mais você se solta, mais forte fica. Confie nas contradições.\n\n💎 Hoje: encontre um paradoxo em sua vida e sorria para ele.'],
    ['4. Transgressão', 'Ultrapasse os limites familiares. Não destruição, mas criação do novo. Faça o que nunca fez: elogie um estranho, escreva um poema, tome um caminho diferente.\n\n💎 Tarefa: realize um pequeno ato de coragem hoje.'],
    ['5. Radicalismo', 'Sem meias-medidas. Diga a si mesmo: "Nunca mais trairei minha profundidade." Uma determinação silenciosa e inabalável de ser você mesmo até o fim.\n\n💎 Prática: diga esta frase em voz alta na frente do espelho.'],
    ['6. Naturalidade', 'Você não precisa se esforçar. Você já é suficiente. Relaxe os ombros, expire, permita-se ser como você é. Isso é o despertar.\n\n💎 Afirmação: "Eu me permito ser. Agora mesmo."']
  ],
  hi: [
    ['1. वास्तविकता', 'अभी आप जो कुछ भी महसूस कर रहे हैं, वही एकमात्र वास्तविकता है। अतीत या भविष्य के विचारों में न भागें। अपनी सांस, ध्वनियों, शरीर की संवेदनाओं पर ध्यान दें। यह भ्रम से मुक्ति का द्वार है।\n\n💎 सुझाव: एक मिनट रुकें, चारों ओर देखें और कहें: "यह मेरा जीवन है। यह वास्तविक है।"'],
    ['2. द्वंद्व', 'आप एक ही समय में क्रोधित और प्रेमपूर्ण हो सकते हैं। यह विरोधाभास नहीं है — यह पूर्णता है। अपने आप को जटिल, अपरिष्कृत, जीवित होने दें।\n\n💎 सुझाव: उस व्यक्ति के बारे में सोचें जिसके प्रति आपकी मिश्रित भावनाएँ हैं और अपने आक्रोश को दबाए बिना उनके अच्छे होने की कामना करें।'],
    ['3. विरोधाभास', 'सत्य लगभग हमेशा विरोधाभासी होता है। जितना अधिक आप देते हैं, उतने ही धनी होते जाते हैं। जितना गहरा आप जाने देते हैं, उतना ही मजबूत होते जाते हैं। विरोधाभासों पर भरोसा करें।\n\n💎 आज: अपने जीवन में एक विरोधाभास खोजें और उस पर मुस्कुराएं।'],
    ['4. अतिक्रमण', 'परिचित सीमाओं से परे कदम रखें। विनाश नहीं, बल्कि नए का सृजन। वह करें जो आपने कभी नहीं किया: किसी अजनबी की तारीफ करें, एक कविता लिखें, एक अलग रास्ता अपनाएं।\n\n💎 कार्य: आज साहस का एक छोटा सा कार्य करें।'],
    ['5. कट्टरता', 'आधे-अधूरे उपाय नहीं। अपने आप से कहें: "मैं फिर कभी अपनी गहराई के साथ विश्वासघात नहीं करूंगा।" अंत तक स्वयं बने रहने का एक शांत, अटल संकल्प।\n\n💎 अभ्यास: दर्पण के सामने इस वाक्यांश को जोर से बोलें।'],
    ['6. स्वाभाविकता', 'आपको प्रयास करने की आवश्यकता नहीं है। आप पहले से ही पर्याप्त हैं। अपने कंधों को आराम दें, साँस छोड़ें, अपने आप को वैसे ही रहने दें जैसे आप हैं। यही जागृति है।\n\n💎 प्रतिज्ञान: "मैं स्वयं को होने की अनुमति देता हूं। अभी और यहीं।"']
  ],
  es: [
    ['1. Realidad', 'Todo lo que sientes ahora mismo es la única realidad. No huyas a pensamientos del pasado o del futuro. Observa tu respiración, los sonidos, las sensaciones corporales. Esta es la puerta a la libertad.\n\n💎 Consejo: Detente un minuto, mira a tu alrededor y di: "Esta es mi vida. Es real."'],
    ['2. Ambivalencia', 'Puedes estar enojado y amoroso al mismo tiempo. Esto no es una contradicción — es plenitud. Permítete ser complejo, no pulido, vivo.\n\n💎 Piensa en alguien por quien tienes sentimientos encontrados y deséale el bien sin reprimir tu resentimiento.'],
    ['3. Paradoja', 'La verdad es casi siempre paradójica. Cuanto más das, más rico te vuelves. Cuanto más sueltas, más fuerte te haces. Confía en las contradicciones.\n\n💎 Hoy: encuentra una paradoja en tu vida y sonríele.'],
    ['4. Transgresión', 'Sal de los límites familiares. No destrucción, sino creación de lo nuevo. Haz lo que nunca has hecho: halaga a un extraño, escribe un poema, toma una ruta diferente.\n\n💎 Tarea: realiza un pequeño acto de valentía hoy.'],
    ['5. Radicalidad', 'Sin medias tintas. Dite a ti mismo: "Nunca más traicionaré mi profundidad." Una determinación silenciosa e inquebrantable de ser tú mismo hasta el final.\n\n💎 Práctica: di esta frase en voz alta frente a un espejo.'],
    ['6. Naturalidad', 'No tienes que esforzarte. Ya eres suficiente. Relaja los hombros, exhala, permítete ser como eres. Esto es el despertar.\n\n💎 Afirmación: "Me permito ser. Ahora mismo."']
  ]
};

// Вставляем переводы (hall 'keys', порядок 1-6)
for (const lang of ['en', 'zh', 'fr', 'pt', 'hi', 'es']) {
  gates[lang].forEach((gate, idx) => {
    insertTranslation('keys', gate[0], gate[1], idx + 1, lang);
  });
}

console.log('🌍 Все языковые версии Шести Врат добавлены!');
process.exit(0);
