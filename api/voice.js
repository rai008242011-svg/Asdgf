// 入力は2通り:
//  (A) テキスト(JSON: { text, history }) … ブラウザの常時聞き取りで文字になったもの
//  (B) 録音データ(application/octet-stream) … 常時聞き取りが使えない端末のための予備
// どちらも → 返答生成(Groq) → { heard, reply } を返す
const GROQ = "https://api.groq.com/openai/v1";

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "GROQ_API_KEY が未設定です" });
  }

  // 合言葉（任意）。APP_PASSCODE を設定した場合だけチェックする
  const pass = process.env.APP_PASSCODE;
  if (pass && req.headers["x-passcode"] !== pass) {
    return res.status(401).json({ error: "合言葉が違います" });
  }

  try {
    let heard = "";
    let history = [];

    if (Buffer.isBuffer(req.body)) {
      // (B) 録音データ → 文字起こし
      const audio = req.body;
      if (audio.length < 1000) {
        return res.status(400).json({ error: "音声が短すぎます" });
      }
      const mime = req.headers["x-mime"] || "audio/webm";
      const ext = mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm";
      const form = new FormData();
      form.append("file", new Blob([audio], { type: mime }), `voice.${ext}`);
      form.append("model", process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo");
      form.append("language", "ja");
      form.append("response_format", "json");

      const sttRes = await fetch(`${GROQ}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
        body: form,
      });
      if (!sttRes.ok) {
        const detail = await sttRes.text();
        return res.status(502).json({ error: "文字起こしに失敗しました", detail });
      }
      heard = ((await sttRes.json()).text || "").trim();
      try {
        const raw = req.headers["x-history"];
        if (raw) history = JSON.parse(decodeURIComponent(raw));
      } catch (_) {}
    } else if (req.body && typeof req.body.text === "string") {
      // (A) テキスト
      heard = req.body.text.trim().slice(0, 1000);
      if (Array.isArray(req.body.history)) history = req.body.history;
    } else {
      return res.status(400).json({ error: "入力が不正です" });
    }

    if (!heard) {
      return res.status(200).json({ heard: "", reply: "" });
    }
    history = history.slice(-6);

    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const system = [
      "あなたの名前はジャービスで、ユーザー専属のAI秘書です。",
      "声で会話しているので、返答は自然な話し言葉で、1〜3文の短さにしてください。",
      "箇条書き、記号、マークダウン、絵文字は使わないでください（読み上げられるため）。",
      "音声認識の誤変換が混じることがあるので、意味が通るように汲み取ってください。",
      "分からないことは分からないと正直に言い、できないことは、できないと伝えてください。",
      `現在の日時（日本時間）: ${now}`,
    ].join("\n");

    const messages = [
      { role: "system", content: system },
      ...history.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: String(m.content || "").slice(0, 500),
      })),
      { role: "user", content: heard },
    ];

    const chatRes = await fetch(`${GROQ}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.GROQ_CHAT_MODEL || "llama-3.3-70b-versatile",
        messages,
        temperature: 0.6,
        max_tokens: 300,
      }),
    });
    if (!chatRes.ok) {
      const detail = await chatRes.text();
      return res.status(502).json({ error: "返答の生成に失敗しました", detail });
    }
    const reply = (((await chatRes.json()).choices || [])[0]?.message?.content || "").trim();

    return res.status(200).json({ heard, reply });
  } catch (e) {
    return res.status(500).json({ error: "サーバーエラー", detail: String(e) });
  }
};
