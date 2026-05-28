const fileInput = document.querySelector("#fileInput");
const chooseFileButton = document.querySelector("#chooseFileButton");
const fileName = document.querySelector("#fileName");
const pageCount = document.querySelector("#pageCount");
const speedButtons = [...document.querySelectorAll(".speed-button")];
const playButton = document.querySelector("#playButton");
const pauseButton = document.querySelector("#pauseButton");
const restartButton = document.querySelector("#restartButton");
const message = document.querySelector("#message");
const progressBar = document.querySelector("#progressBar");
const progressLabel = document.querySelector("#progressLabel");
const prevPageButton = document.querySelector("#prevPageButton");
const nextPageButton = document.querySelector("#nextPageButton");
const pageInput = document.querySelector("#pageInput");

const state = {
  pages: [],
  selectedPageIndex: 0,
  currentPageIndex: 0,
  chunkIndex: 0,
  loaded: false,
  loading: false,
  reading: false,
  speed: 1,
  voice: null,
  speechToken: 0,
};

let pdfjsLibPromise = null;

chooseFileButton.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const [file] = fileInput.files;
  if (file) {
    loadPdf(file);
  }
});

speedButtons.forEach((button) => {
  button.addEventListener("click", () => {
    setSpeed(Number(button.dataset.speed));
  });
});

playButton.addEventListener("click", play);
pauseButton.addEventListener("click", stopReading);
restartButton.addEventListener("click", restart);
prevPageButton.addEventListener("click", () => selectPage(state.selectedPageIndex - 1));
nextPageButton.addEventListener("click", () => selectPage(state.selectedPageIndex + 1));
pageInput.addEventListener("change", () => {
  selectPage(Number(pageInput.value) - 1);
});

window.addEventListener("beforeunload", () => {
  speechSynthesis.cancel();
});

loadVoices();
if ("addEventListener" in speechSynthesis) {
  speechSynthesis.addEventListener("voiceschanged", loadVoices);
} else {
  speechSynthesis.onvoiceschanged = loadVoices;
}
updateUi();

async function loadPdf(file) {
  stopReading();
  resetReader();
  state.loading = true;
  chooseFileButton.disabled = true;
  fileName.textContent = file.name;
  pageCount.textContent = "";
  setMessage("PDFを読み込んでいます。");
  updateUi();

  try {
    const pdfjsLib = await getPdfJs();
    const data = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];

    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      setMessage(`PDFを読み込んでいます。${pageNumber}/${pdf.numPages}ページ`);
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = normalizeJapaneseText(textContentToParagraph(content.items));
      pages.push({
        pageNumber,
        chunks: splitForSpeech(text),
      });
    }

    state.pages = pages;
    state.selectedPageIndex = 0;
    state.currentPageIndex = 0;
    state.chunkIndex = 0;
    state.loaded = pages.some((page) => page.chunks.length > 0);
    pageCount.textContent = `${pdf.numPages}ページ`;
    pageInput.max = String(pdf.numPages);
    pageInput.value = "1";

    if (!state.loaded) {
      setMessage("読み上げられるテキストを見つけられませんでした。画像だけのPDFはOCRが必要です。");
      return;
    }

    setMessage("読み込み完了。ページと速度を選んで「読む」を押してください。");
    updateProgress();
  } catch (error) {
    console.error(error);
    fileName.textContent = "読み込みに失敗しました";
    setMessage("PDFを読み込めませんでした。別のPDFで試してください。");
  } finally {
    state.loading = false;
    chooseFileButton.disabled = false;
    updateUi();
  }
}

async function getPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import("./vendor/pdfjs/pdf.mjs").then((pdfjsLib) => {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdfjs/pdf.worker.mjs";
      return pdfjsLib;
    });
  }

  return pdfjsLibPromise;
}

function textContentToParagraph(items) {
  const textItems = items
    .map((item) => {
      const text = normalizePdfFragment(item.str || "");
      const [, , , , x = 0, y = 0] = item.transform || [];
      return {
        text,
        x,
        y,
        width: Number(item.width) || 0,
        height: Number(item.height) || 0,
        hasEOL: Boolean(item.hasEOL),
      };
    })
    .filter((item) => item.text);

  const uniqueItems = removeOverprintedText(textItems);
  const lines = groupItemsIntoLines(uniqueItems);

  return lines
    .map((line) =>
      line
        .sort((a, b) => a.x - b.x)
        .map((item, index, sortedLine) => {
          if (index === 0) {
            return item.text;
          }
          const previous = sortedLine[index - 1];
          const gap = item.x - (previous.x + previous.width);
          return needsSpaceBetween(previous.text, item.text, gap) ? ` ${item.text}` : item.text;
        })
        .join("")
    )
    .join("\n");
}

function normalizeJapaneseText(text) {
  return text
    .normalize("NFKC")
    .replace(/\u0000/g, "")
    .replace(/[‐‑‒–—―ー]{2,}/g, "ー")
    .replace(/[ \t]+/g, " ")
    .replace(/([ぁ-んァ-ヶ一-龠々〆〤])\s+([ぁ-んァ-ヶ一-龠々〆〤])/g, "$1$2")
    .replace(/([ぁ-んァ-ヶ一-龠々〆〤])\n+([ぁ-んァ-ヶ一-龠々〆〤])/g, "$1$2")
    .replace(/\n{2,}/g, "。")
    .replace(/\n/g, "。")
    .replace(/。{2,}/g, "。")
    .replace(/\s{2,}/g, " ")
    .split("。")
    .map(repairRepeatedReadingNoise)
    .join("。")
    .trim();
}

function normalizePdfFragment(text) {
  return text
    .normalize("NFKC")
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function removeOverprintedText(items) {
  const seen = new Set();
  const result = [];

  for (const item of items) {
    const key = [
      item.text,
      Math.round(item.x * 2) / 2,
      Math.round(item.y * 2) / 2,
      Math.round(item.width),
      Math.round(item.height),
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    const nearbyDuplicate = result.some((existing) => {
      if (existing.text !== item.text) {
        return false;
      }
      return Math.abs(existing.x - item.x) < 1.2 && Math.abs(existing.y - item.y) < 1.2;
    });

    if (!nearbyDuplicate) {
      seen.add(key);
      result.push(item);
    }
  }

  return result;
}

function groupItemsIntoLines(items) {
  const sorted = [...items].sort((a, b) => {
    if (Math.abs(b.y - a.y) > 3) {
      return b.y - a.y;
    }
    return a.x - b.x;
  });

  const lines = [];

  for (const item of sorted) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= Math.max(3, item.height * 0.35));
    if (line) {
      line.items.push(item);
      line.y = (line.y + item.y) / 2;
    } else {
      lines.push({ y: item.y, items: [item] });
    }
  }

  return lines.map((line) => line.items);
}

function needsSpaceBetween(left, right, gap) {
  if (gap < 4) {
    return false;
  }
  const leftJapanese = /[ぁ-んァ-ヶ一-龠々〆〤、。！？]/.test(left.at(-1));
  const rightJapanese = /^[ぁ-んァ-ヶ一-龠々〆〤、。！？]/.test(right);
  return !(leftJapanese && rightJapanese);
}

function repairRepeatedReadingNoise(text) {
  let repaired = text;
  repaired = repaired.replace(/([ぁ-んァ-ヶ一-龠々〆〤ー])\1{2,}/g, "$1");

  const repeatedJapanesePairs = repaired.match(/([ぁ-んァ-ヶ一-龠々〆〤])\1/g) || [];

  if (repeatedJapanesePairs.length >= 2) {
    repaired = repaired.replace(/([ぁ-んァ-ヶ一-龠々〆〤])\1/g, "$1");
  }

  repaired = repaired
    .replace(/([一-龠々〆〤]{2,24})\1+/g, "$1")
    .replace(/([ぁ-んァ-ヶ一-龠々〆〤ー]{3,24})\1+/g, "$1");

  return repaired;
}

function splitForSpeech(text) {
  if (!text) {
    return [];
  }

  const sentences = text.match(/[^。！？!?]+[。！？!?]?/g) || [text];
  const chunks = [];

  for (const rawSentence of sentences) {
    let sentence = rawSentence.trim();
    while (sentence.length > 110) {
      const cut = findChunkBreak(sentence, 110);
      chunks.push(sentence.slice(0, cut).trim());
      sentence = sentence.slice(cut).trim();
    }
    if (sentence) {
      chunks.push(sentence);
    }
  }

  return chunks.filter(Boolean);
}

function findChunkBreak(text, limit) {
  const window = text.slice(0, limit);
  const comma = Math.max(window.lastIndexOf("、"), window.lastIndexOf("，"));
  if (comma > 35) {
    return comma + 1;
  }
  const space = window.lastIndexOf(" ");
  if (space > 35) {
    return space + 1;
  }
  return limit;
}

function setSpeed(nextSpeed) {
  state.speed = nextSpeed;

  speedButtons.forEach((button) => {
    button.classList.toggle("is-active", Number(button.dataset.speed) === nextSpeed);
  });

  if (state.reading) {
    state.speechToken += 1;
    speechSynthesis.cancel();
    window.setTimeout(speakCurrentChunk, 80);
    setMessage(`速度 x${formatSpeed(nextSpeed)} で読み上げています。`);
  } else if (state.loaded) {
    setMessage(`速度 x${formatSpeed(nextSpeed)} を選びました。「読む」で開始します。`);
  }

  updateUi();
}

function play() {
  if (!state.loaded || state.loading) {
    return;
  }

  state.currentPageIndex = state.selectedPageIndex;
  state.chunkIndex = 0;

  state.reading = true;
  speakCurrentChunk();
  updateUi();
}

function speakCurrentChunk() {
  const page = state.pages[state.currentPageIndex];
  const chunks = page?.chunks || [];

  if (!state.reading || !page) {
    finishIfNeeded();
    return;
  }

  if (chunks.length === 0 || state.chunkIndex >= chunks.length) {
    if (moveToNextReadablePage()) {
      speakCurrentChunk();
    } else {
      finishReading();
    }
    return;
  }

  state.speechToken += 1;
  const token = state.speechToken;
  const utterance = new SpeechSynthesisUtterance(chunks[state.chunkIndex]);
  utterance.lang = "ja-JP";
  utterance.rate = speechEngineRate(state.speed);
  utterance.pitch = 1;
  utterance.volume = 1;
  if (state.voice) {
    utterance.voice = state.voice;
  }

  utterance.onstart = () => {
    if (token !== state.speechToken) {
      return;
    }
    state.reading = true;
    updateProgress();
    updateUi();
  };
  utterance.onend = () => {
    if (token !== state.speechToken || !state.reading) {
      return;
    }
    state.chunkIndex += 1;
    updateProgress();
    if (state.chunkIndex >= chunks.length) {
      if (moveToNextReadablePage()) {
        speakCurrentChunk();
      } else {
        finishReading();
      }
    } else {
      speakCurrentChunk();
    }
  };
  utterance.onerror = () => {
    if (token !== state.speechToken) {
      return;
    }
    state.reading = false;
    setMessage("読み上げが中断されました。もう一度「読む」を押してください。");
    updateUi();
  };

  setMessage(`速度 x${formatSpeed(state.speed)} で読み上げています。`);
  speechSynthesis.speak(utterance);
}

function pauseCurrentSpeech() {
  state.speechToken += 1;
  speechSynthesis.cancel();
  state.reading = false;
}

function stopReading() {
  state.speechToken += 1;
  speechSynthesis.cancel();
  state.reading = false;
  if (state.loaded) {
    setMessage("読み上げを止めました。");
  }
  updateUi();
}

function restart() {
  if (!state.loaded) {
    return;
  }
  state.speechToken += 1;
  speechSynthesis.cancel();
  state.selectedPageIndex = 0;
  state.currentPageIndex = 0;
  state.chunkIndex = 0;
  pageInput.value = "1";
  updateProgress();
  state.reading = true;
  speakCurrentChunk();
  updateUi();
}

function finishReading() {
  state.speechToken += 1;
  speechSynthesis.cancel();
  state.reading = false;
  const page = state.pages[state.currentPageIndex];
  state.chunkIndex = page ? page.chunks.length : 0;
  updateProgress();
  setMessage("最後まで読み上げました。");
  updateUi();
}

function finishIfNeeded() {
  const page = state.pages[state.currentPageIndex];
  if (!page && state.loaded) {
    finishReading();
  }
  if (page && state.chunkIndex >= page.chunks.length && state.loaded && state.currentPageIndex >= state.pages.length - 1) {
    finishReading();
  }
}

function resetReader() {
  state.pages = [];
  state.selectedPageIndex = 0;
  state.currentPageIndex = 0;
  state.chunkIndex = 0;
  state.loaded = false;
  state.reading = false;
  progressBar.style.width = "0%";
  progressLabel.textContent = "待機中";
  pageInput.value = "1";
  pageInput.removeAttribute("max");
}

function updateProgress() {
  const page = state.pages[state.currentPageIndex] || state.pages[state.selectedPageIndex];
  const total = page?.chunks.length || 0;
  const current = Math.min(state.chunkIndex, total);
  const percent = total ? Math.round((current / total) * 100) : 0;
  progressBar.style.width = `${percent}%`;
  progressLabel.textContent = total ? `${page.pageNumber}ページ目 ${current} / ${total}` : "待機中";
}

function updateUi() {
  playButton.disabled = !state.loaded || state.loading;
  pauseButton.disabled = !state.loaded || state.loading || (!state.reading && !speechSynthesis.speaking);
  restartButton.disabled = !state.loaded || state.loading;
  prevPageButton.disabled = !state.loaded || state.loading || state.selectedPageIndex <= 0;
  nextPageButton.disabled = !state.loaded || state.loading || state.selectedPageIndex >= state.pages.length - 1;
  pageInput.disabled = !state.loaded || state.loading;
}

function setMessage(text) {
  message.textContent = text;
}

function selectPage(index) {
  if (!state.pages.length) {
    return;
  }

  if (state.reading || speechSynthesis.speaking) {
    state.speechToken += 1;
    speechSynthesis.cancel();
    state.reading = false;
  }

  const nextIndex = clamp(Math.trunc(index), 0, state.pages.length - 1);
  state.selectedPageIndex = nextIndex;
  state.currentPageIndex = nextIndex;
  state.chunkIndex = 0;
  pageInput.value = String(state.pages[nextIndex].pageNumber);
  updateProgress();
  setMessage(`${state.pages[nextIndex].pageNumber}ページ目を選びました。「読む」でここから開始します。`);
  updateUi();
}

function moveToNextReadablePage() {
  for (let index = state.currentPageIndex + 1; index < state.pages.length; index += 1) {
    if (state.pages[index].chunks.length > 0) {
      state.currentPageIndex = index;
      state.selectedPageIndex = index;
      state.chunkIndex = 0;
      pageInput.value = String(state.pages[index].pageNumber);
      updateProgress();
      updateUi();
      return true;
    }
  }

  return false;
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function formatSpeed(speed) {
  if (speed === 1) {
    return "1";
  }
  return speed === 2 ? "2.0" : String(speed);
}

function speechEngineRate(speed) {
  if (speed === 1.5) {
    return 1.18;
  }
  if (speed === 2) {
    return 1.34;
  }
  return 0.95;
}

function loadVoices() {
  const voices = speechSynthesis.getVoices();
  state.voice =
    voices.find((voice) => voice.lang === "ja-JP" && /Google|Kyoko|Otoya|Nanami|Haruka|Ichiro/i.test(voice.name)) ||
    voices.find((voice) => voice.lang === "ja-JP") ||
    voices.find((voice) => voice.lang.startsWith("ja")) ||
    null;
}
