import ZAI from 'z-ai-web-dev-sdk';
import fs from 'fs';

async function analyze(path, prompt) {
  const zai = await ZAI.create();
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

const foldPrompt = `Describe this e-commerce desktop homepage screenshot in detail: 1) List the page regions top to bottom. 2) Is there a slim dark utility bar at the very top? What does it contain? 3) Describe the main header (logo, search field, icons). 4) Is there a dark horizontal navigation bar below the header? List its items. 5) Describe the hero banner area (height, imagery, text, call-to-action, secondary tiles). 6) Any visual defects: overlapping elements, broken images, misalignment, text overflow, empty gaps?`;

const fullPrompt = `This is a full-page screenshot of a desktop e-commerce marketplace homepage. Check: 1) All sections present in order (utility bar, header, nav bar, hero carousel, quick-access shortcuts, campaign showcase, flash deals, categories, trending products, featured picks, featured stores, new arrivals, footer). 2) Do product cards show prices, discount badges, ratings? 3) Do flash-deal/trending cards show an "Add to cart" button and a heart icon? 4) Footer structure: how many link groups, what's in the bottom bar? 5) Any visual defects anywhere: broken images, overlapping/misaligned elements, inconsistent spacing, stretched images?`;

try {
  console.log('=== FOLD ===');
  console.log(await analyze('/tmp/desktop-home-fold.png', foldPrompt));
} catch (e) {
  console.error('FOLD analysis failed:', e.message);
}

try {
  console.log('=== FULL ===');
  console.log(await analyze('/tmp/desktop-home-full.png', fullPrompt));
} catch (e) {
  console.error('FULL analysis failed:', e.message);
}
