import ZAI from 'z-ai-web-dev-sdk';
import fs from 'fs';

async function analyze(zai, path, prompt) {
  const b64 = fs.readFileSync(path).toString('base64');
  const res = await zai.chat.completions.createVision({
    messages: [
      { role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${b64}` } }
      ]}
    ],
    thinking: { type: 'disabled' }
  });
  return res.choices[0].message.content;
}

const zai = await ZAI.create();

const stitchedPrompt = `This is a full-page screenshot of a desktop e-commerce marketplace homepage (captured by stitching real viewport screenshots while scrolling — so it shows the page as a user actually sees it). Analyze: 1) List every section in order from top to bottom (utility bar, header, nav, hero, quick-access, campaign showcase, flash deals, categories, trending, featured picks, featured stores, new arrivals, footer). 2) For product cards: do they show prices, discount badges (-XX%), star ratings? 3) Do flash-deal and trending product cards show an "Add to cart" button and a heart/wishlist icon? 4) Describe the flash deals section (countdown timer? how many cards?). 5) Footer: how many link groups, what is in the very bottom bar? Is the link text properly spaced or run together? 6) Any visual defects: broken images, overlapping elements, misalignment, inconsistent spacing, stretched images, text overflow? 7) Overall: does it look like a coherent modern teal-branded marketplace?`;

const footerPrompt = `This is a close-up of a website footer (teal background). Describe: 1) The heading/brand area. 2) Each link group and its links — read the link text carefully. 3) Is the text properly spaced with clear gaps between separate links, or do link labels visually run together? 4) The bottom bar contents (copyright, buttons). 5) Any defects.`;

try {
  console.log('=== STITCHED FULL ===');
  console.log(await analyze(zai, '/home/z/my-project/agent-ctx/stitched-full.png', stitchedPrompt));
} catch (e) { console.error('stitched failed:', e.message); }

try {
  console.log('=== FOOTER CLOSE-UP ===');
  console.log(await analyze(zai, '/home/z/my-project/agent-ctx/stitch-footer.png', footerPrompt));
} catch (e) { console.error('footer failed:', e.message); }
