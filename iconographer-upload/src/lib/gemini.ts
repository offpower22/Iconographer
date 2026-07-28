// Thin wrapper around the Gemini REST API (free tier). We ask the vision model
// to locate concrete visual elements — objects, animals, gestures, poses,
// garments/colors — with bounding boxes so the UI can crop each one. Gemini
// never assigns meaning; that comes only from data/symbols.json.

export interface GeminiDetection {
  element: string;
  location: string;
  /** normalized [ymin, xmin, ymax, xmax], each 0..1000 (Gemini's convention) */
  box: [number, number, number, number] | null;
}

export interface GeminiVisionResult {
  detectedElements: GeminiDetection[];
}

// Chosen because it's confirmed to have free-tier quota; some other free-tier-listed
// models (e.g. gemini-2.0-flash) return quota:0 depending on the Google Cloud project.
// Override via GEMINI_MODEL if your project has quota on a different model.
const DEFAULT_MODEL = 'gemini-flash-lite-latest';

const SYSTEM_PROMPT = `You are a computer vision system assisting an iconography app. You do NOT
interpret meaning — you only locate and label what is visibly present in a photograph of an
artwork (painting, sculpture, fresco, icon, print, etc.).

Identify every discrete visual element that could carry iconographic meaning:
- objects held or nearby (e.g. "book", "skull", "keys", "broken wheel")
- animals (e.g. "lion", "dragon", "dove")
- hand gestures and body poses (e.g. "index finger raised", "hand on chest", "kneeling pose",
  "two fingers raised in blessing", "palm facing outward") — these matter as much as objects
- garments and colors (e.g. "blue mantle", "red robe", "camel hair garment")
- distinctive attributes (e.g. "halo", "wings", "crown", "stigmata")

For each element, also return a tight bounding box around exactly that element (not the whole
figure, not the whole painting) as box_2d: [ymin, xmin, ymax, xmax], integers from 0 to 1000,
where the image's top-left corner is (0,0) and bottom-right is (1000,1000).

Rules:
- Report only what you can actually see. Do not guess symbolic meaning — that is not your job.
- Use short, lowercase noun phrases for "element" (e.g. "lion", "index finger raised", "blue mantle").
- Prefer specific, minimal bounding boxes over boxes that cover the whole figure.
- "location" is a short human-readable position (e.g. "bottom left", "held in right hand").
- If the image is not an artwork or you cannot see meaningful detail, return an empty array.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    detectedElements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          element: { type: 'string' },
          location: { type: 'string' },
          box_2d: {
            type: 'array',
            items: { type: 'integer' },
            minItems: 4,
            maxItems: 4
          }
        },
        required: ['element', 'location', 'box_2d']
      }
    }
  },
  required: ['detectedElements']
};

export class GeminiError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

/**
 * Send an image to Gemini and get back located, unlabeled-by-meaning detections.
 * @param imageBase64 raw base64 (no data: prefix)
 * @param mimeType e.g. "image/jpeg"
 */
export async function analyzeImage(
  imageBase64: string,
  mimeType: string,
  apiKey: string,
  model = DEFAULT_MODEL
): Promise<GeminiVisionResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body = {
    systemInstruction: {
      parts: [{ text: SYSTEM_PROMPT }]
    },
    contents: [
      {
        role: 'user',
        parts: [
          { text: 'Locate the iconographically relevant elements in this image and return the structured JSON.' },
          { inlineData: { mimeType, data: imageBase64 } }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA
    }
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch (err) {
    throw new GeminiError('Could not reach the analysis service.', 502);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 429) {
      throw new GeminiError('The free analysis quota is busy right now. Try again in a moment.', 429);
    }
    if (res.status === 400 && /API key/i.test(detail)) {
      throw new GeminiError('The server is missing a valid Gemini API key.', 500);
    }
    throw new GeminiError(`Analysis service error (${res.status}).`, 502);
  }

  const json: any = await res.json();
  const text: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    const blocked = json?.promptFeedback?.blockReason;
    throw new GeminiError(
      blocked ? 'The image could not be analyzed (content was blocked).' : 'The analysis service returned no result.',
      502
    );
  }

  let parsed: { detectedElements?: unknown };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GeminiError('The analysis service returned an unreadable result.', 502);
  }

  const raw = Array.isArray(parsed.detectedElements) ? parsed.detectedElements : [];

  return {
    detectedElements: raw
      .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && typeof (e as any).element === 'string')
      .map((e) => {
        const box = Array.isArray(e.box_2d) && e.box_2d.length === 4 && e.box_2d.every((n) => typeof n === 'number')
          ? ([e.box_2d[0], e.box_2d[1], e.box_2d[2], e.box_2d[3]] as [number, number, number, number])
          : null;
        return {
          element: String(e.element),
          location: typeof e.location === 'string' ? e.location : '',
          box
        };
      })
  };
}
