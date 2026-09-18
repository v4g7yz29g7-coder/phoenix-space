document.addEventListener('DOMContentLoaded', function() {
  var fileInput = document.getElementById('fileInput');
  var previewGrid = document.getElementById('previewGrid');
  var uploadBtn = document.getElementById('uploadBtn');
  var generateBtn = document.getElementById('generateBtn');
  var downloadBtn = document.getElementById('downloadBtn');
  var loginBtn = document.getElementById('loginBtn');
  var layoutSelect = document.getElementById('layoutSelect');

  var selectedFiles = [];
  var selectedDataUrls = [];
  var uploadSection = document.querySelector('.upload-section');

  uploadBtn.addEventListener('click', function() { fileInput.click(); });

  fileInput.addEventListener('change', function(e) {
    selectedFiles = Array.from(e.target.files);
    selectedDataUrls = [];
    renderPreview(selectedFiles);
    uploadSection.classList.remove('dimmed');
  });

  function renderPreview(files) {
    previewGrid.innerHTML = '';
    if (!files.length) {
      previewGrid.innerHTML = '<p>Фотографии не выбраны</p>';
      return;
    }
    files.forEach(function(file) {
      var reader = new FileReader();
      reader.onload = function(ev) {
        selectedDataUrls.push(ev.target.result);
        var card = document.createElement('div');
        card.className = 'photo-card';
        var img = document.createElement('img');
        img.src = ev.target.result;
        img.className = 'photo-preview';
        card.appendChild(img);
        previewGrid.appendChild(card);
      };
      reader.readAsDataURL(file);
    });
  }

  function renderCollage(photos, layoutName) {
    var collageSection = document.getElementById('collageSection');
    if (!collageSection) {
      collageSection = document.createElement('div');
      collageSection.id = 'collageSection';
      collageSection.style.marginTop = '24px';
      collageSection.style.paddingTop = '24px';
      collageSection.style.borderTop = '1px solid rgba(255,255,255,0.08)';
      uploadSection.parentNode.appendChild(collageSection);
    }

    var container = document.getElementById('collage');
    if (!container) {
      container = document.createElement('div');
      container.id = 'collage';
      container.style.margin = '16px auto 0';
      container.style.maxWidth = '100%';
      container.style.width = '100%';
      container.style.boxSizing = 'border-box';
      container.style.overflow = 'hidden';
      collageSection.appendChild(container);
    } else {
      container.innerHTML = '';
    }

    container.className = 'collage collage-' + layoutName;

    if (layoutName === 'carousel') {
      container.style.display = 'flex';
      container.style.flexDirection = 'column';
      container.style.gap = '12px';
      photos.forEach(function(file, index) {
        var page = document.createElement('div');
        page.style.display = 'flex';
        page.style.alignItems = 'center';
        page.style.gap = '12px';
        var img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.style.width = '80px';
        img.style.height = '80px';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '10px';
        var caption = document.createElement('div');
        caption.textContent = 'Кадр ' + (index + 1);
        caption.style.color = '#fff';
        caption.style.fontSize = '16px';
        page.appendChild(img);
        page.appendChild(caption);
        container.appendChild(page);
      });
    } else if (layoutName === 'before-after') {
      container.style.display = 'flex';
      container.style.flexWrap = 'wrap';
      container.style.gap = '8px';
      for (var i = 0; i < photos.length; i += 2) {
        var img1 = document.createElement('img');
        img1.src = URL.createObjectURL(photos[i]);
        img1.style.width = 'calc(50% - 4px)';
        img1.style.height = '120px';
        img1.style.objectFit = 'cover';
        img1.style.borderRadius = '8px';
        container.appendChild(img1);
        if (photos[i + 1]) {
          var img2 = document.createElement('img');
          img2.src = URL.createObjectURL(photos[i + 1]);
          img2.style.width = 'calc(50% - 4px)';
          img2.style.height = '120px';
          img2.style.objectFit = 'cover';
          img2.style.borderRadius = '8px';
          container.appendChild(img2);
        }
      }
    } else if (layoutName === 'moodboard') {
      container.style.display = 'flex';
      container.style.flexWrap = 'wrap';
      container.style.gap = '8px';
      photos.forEach(function(file, index) {
        var img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.style.borderRadius = '12px';
        img.style.objectFit = 'cover';
        if (index === 0) {
          img.style.width = '100%';
          img.style.height = '200px';
        } else {
          img.style.width = 'calc(50% - 4px)';
          img.style.height = '100px';
        }
        container.appendChild(img);
      });
    } else if (layoutName === 'filmstrip') {
      container.style.display = 'flex';
      container.style.overflowX = 'auto';
      container.style.gap = '6px';
      container.style.padding = '10px';
      container.style.background = '#1a1a1a';
      container.style.borderRadius = '6px';
      photos.forEach(function(file) {
        var img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.style.width = '90px';
        img.style.height = '60px';
        img.style.objectFit = 'cover';
        img.style.border = '2px solid #fff';
        img.style.borderRadius = '6px';
        img.style.flexShrink = '0';
        container.appendChild(img);
      });
    } else if (layoutName === 'polaroid-stack') {
      container.style.position = 'relative';
      container.style.height = '280px';
      photos.forEach(function(file, index) {
        var img = document.createElement('img');
        img.src = URL.createObjectURL(file);
        img.style.position = 'absolute';
        img.style.left = (index * 8) + 'px';
        img.style.top = (index * 8) + 'px';
        img.style.width = '140px';
        img.style.height = '140px';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '6px';
        img.style.boxShadow = '0 4px 12px rgba(0,0,0,0.4)';
        img.style.transform = 'rotate(' + (Math.random() * 8 - 4) + 'deg)';
        img.style.zIndex = index;
        container.appendChild(img);
      });
    }

    if (!document.getElementById('collageTitle')) {
      var title = document.createElement('div');
      title.id = 'collageTitle';
      title.className = 'collage-title';
      title.textContent = 'Результат';
      collageSection.insertBefore(title, container);
    }
  }

  generateBtn.addEventListener('click', function() {
    if (!selectedFiles.length) { alert('Сначала выберите фотографии'); return; }
    var layout = layoutSelect ? layoutSelect.value : 'carousel';
    renderCollage(selectedFiles, layout);
    uploadSection.classList.add('dimmed');
  });

  downloadBtn.addEventListener('click', function() {
    if (!selectedDataUrls.length) { alert('Сначала сгенерируйте коллаж'); return; }
    var layout = layoutSelect ? layoutSelect.value : 'carousel';
    exportCollage(selectedDataUrls, layout, 1080);
  });

  loginBtn.addEventListener('click', function() { alert('Вход скоро будет доступен'); });
});
