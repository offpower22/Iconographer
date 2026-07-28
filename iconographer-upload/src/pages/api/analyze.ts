import type { APIRoute } from 'astro';
import { analyzeImage, GeminiError } from '../../lib/gemini';
import { matchSymbols, suggestFigure, type SymbolMatch, type FigureSuggestion } from '../../lib/iconography';

// On-demand (serverless) — this is the only non-static route in the app.
export const prerender = false;

const MAX_BYTES = 8 * 1024 * 1024; // 8 MB — plenty for a phone photo, keeps us in free-tier limits.
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

interface AnalyzeResponse {
  symbols: SymbolMatch[];
  unmatchedElements: string[];
  figureSuggestion: FigureSuggestion | null;
  message: string | null;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

export const POST: APIRoute = async ({ request }) => {
  const apiKey = import.meta.env.GEMINI_API_KEY ?? process.env.GEMINI_API_KEY;
  const model = import.meta.env.GEMINI_MODEL ?? process.env.GEMINI_MODEL ?? undefined;

  if (!apiKey) {
    return json(
      { error: 'The server is not configured with a GEMINI_API_KEY. See .env.example.' },
      500
    );
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const value = form.get('image');
    if (value instanceof File) file = value;
  } catch {
    return json({ error: 'Could not read the uploaded image.' }, 400);
  }

  if (!file) {
    return json({ error: 'No image was uploaded. Attach a photo under the "image" field.' }, 400);
  }
  if (file.size === 0) {
    return json({ error: 'The uploaded image is empty.' }, 400);
  }
  if (file.size > MAX_BYTES) {
    return json({ error: 'That image is too large. Please use one under 8 MB.' }, 413);
  }

  const mimeType = file.type || 'image/jpeg';
  if (!ALLOWED_TYPES.includes(mimeType)) {
    return json({ error: `Unsupported image type: ${mimeType}.` }, 415);
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const imageBase64 = buffer.toString('base64');

  let vision;
  try {
    vision = await analyzeImage(imageBase64, mimeType, apiKey, model);
  } catch (err) {
    if (err instanceof GeminiError) {
      return json({ error: err.message }, err.status);
    }
    return json({ error: 'Unexpected error during analysis.' }, 500);
  }

  // Symbol-first: every detected element that matches our reference data becomes
  // its own explained, croppable card. No forced "one figure" verdict — a figure
  // is only ever a derived, optional bonus signal, never an invented claim.
  const symbols = matchSymbols(vision.detectedElements);
  const matchedRaw = new Set(symbols.map((s) => s.matchedElement.toLowerCase()));
  const unmatchedElements = vision.detectedElements
    .map((d) => d.element)
    .filter((el) => !matchedRaw.has(el.toLowerCase()));

  const figureSuggestion = suggestFigure(symbols);

  let message: string | null = null;
  if (vision.detectedElements.length === 0) {
    message = "I couldn't make out any iconographic details in this image. Try a clearer, closer shot.";
  } else if (symbols.length === 0) {
    message = "I detected some elements, but none matched anything in the reference set yet.";
  }

  const payload: AnalyzeResponse = { symbols, unmatchedElements, figureSuggestion, message };
  return json(payload);
};

export const GET: APIRoute = () =>
  json({ error: 'Use POST with multipart/form-data (field "image").' }, 405);
