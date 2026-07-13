/**
 * Upgrade existing CATDEMO presentations with themes, story sections,
 * short bullets, and quality-friendly slide types.
 *
 * Usage: node scripts/upgradeProductCatalogPresentations.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const env = require('../src/config/env');
const Product = require('../src/models/Product');
const ProductPresentation = require('../src/models/ProductPresentation');
const { evaluatePresentationQuality } = require('../src/services/presentationQuality.service');

const PREFIX = 'CATDEMO';

function oid() {
  return new mongoose.Types.ObjectId();
}

function buildStory(productName, focus, theme) {
  const sections = [
    { sectionId: oid(), key: 'PROBLEM', title: 'Problem', sortOrder: 0, isOptional: false, slideIds: [] },
    { sectionId: oid(), key: 'OUR_PRODUCT', title: 'Our Product', sortOrder: 1, isOptional: false, slideIds: [] },
    { sectionId: oid(), key: 'KEY_BENEFITS', title: 'Key Benefits', sortOrder: 2, isOptional: false, slideIds: [] },
    {
      sectionId: oid(),
      key: 'CLINICAL_EVIDENCE',
      title: 'Clinical Evidence',
      sortOrder: 3,
      isOptional: true,
      slideIds: []
    },
    { sectionId: oid(), key: 'SUMMARY', title: 'Summary', sortOrder: 4, isOptional: false, slideIds: [] },
    { sectionId: oid(), key: 'CTA', title: 'Call To Action', sortOrder: 5, isOptional: true, slideIds: [] }
  ];

  const slides = [
    {
      slideId: oid(),
      sortOrder: 0,
      type: 'PROBLEM',
      sectionId: sections[0].sectionId,
      title: `When everyday care needs more`,
      body: focus.problem || `Patients need clearer options than the current standard.`,
      highlight: null,
      bullets: undefined,
      isOfflineEligible: true
    },
    {
      slideId: oid(),
      sortOrder: 1,
      type: 'HERO',
      sectionId: sections[1].sectionId,
      title: productName,
      body: focus.hero || `A trusted choice for better outcomes.`,
      highlight: focus.tagline || null,
      isOfflineEligible: true
    },
    {
      slideId: oid(),
      sortOrder: 2,
      type: 'BENEFITS',
      sectionId: sections[2].sectionId,
      title: 'Key Benefits',
      body: '',
      bullets: focus.benefits || [
        'Clear clinical role',
        'Practical dosing',
        'Strong brand trust'
      ],
      isOfflineEligible: true
    },
    {
      slideId: oid(),
      sortOrder: 3,
      type: 'CLINICAL',
      sectionId: sections[3].sectionId,
      title: 'Clinical Evidence',
      body: focus.clinical || 'Supported by established clinical practice.',
      highlight: focus.stat || null,
      isOfflineEligible: true
    },
    {
      slideId: oid(),
      sortOrder: 4,
      type: 'SUMMARY',
      sectionId: sections[4].sectionId,
      title: 'Remember',
      body: '',
      bullets: focus.summary || ['Effective', 'Convenient', 'Trusted'],
      isOfflineEligible: true
    },
    {
      slideId: oid(),
      sortOrder: 5,
      type: 'CTA',
      sectionId: sections[5].sectionId,
      title: 'Next Step',
      body: '',
      bullets: ['Discuss suitability for your next patient'],
      highlight: focus.cta || 'Start with a sample discussion today',
      isOfflineEligible: true
    }
  ];

  sections.forEach((sec, i) => {
    sec.slideIds = [slides[i].slideId];
  });

  return { sections, slides, theme };
}

const THEMES = {
  cardio: { primaryColor: '#0B6E4F', secondaryColor: '#083D77', surfaceStyle: 'brandWash' },
  pain: { primaryColor: '#0F766E', secondaryColor: '#134E4A', surfaceStyle: 'dark' },
  medi: { primaryColor: '#1D4ED8', secondaryColor: '#0F172A', surfaceStyle: 'brandWash' },
  vita: { primaryColor: '#15803D', secondaryColor: '#14532D', surfaceStyle: 'brandWash' }
};

const FOCUS_BY_SKU = {
  [`${PREFIX}-LIS-10`]: {
    theme: 'cardio',
    problem: 'Uncontrolled BP still drives stroke and heart failure risk.',
    tagline: 'Once-daily ACE protection',
    benefits: ['Once-daily dosing', 'Proven BP reduction', 'Cardiac protection post-MI'],
    clinical: 'Outcome data supports ACE inhibitors in high-risk hypertensives.',
    stat: 'OD',
    summary: ['Reliable first-line ACE', 'Simple titration', 'CardioLife flagship'],
    cta: 'Recommend Lisinopril 10mg to start'
  },
  [`${PREFIX}-LOS-50`]: {
    theme: 'cardio',
    problem: 'ACE cough makes adherence difficult for many patients.',
    tagline: 'Cough-sparing ARB',
    benefits: ['No ACE cough', 'Renal protection in T2DM', 'Once daily'],
    clinical: 'LIFE trial: losartan reduced stroke vs atenolol in hypertensives.',
    summary: ['Ideal ACE-intolerant switch', 'Stroke risk focus', 'Daily convenience'],
    cta: 'Switch cough-intolerant patients to Losartan'
  },
  [`${PREFIX}-ATO-20`]: {
    theme: 'cardio',
    problem: 'LDL remains above target in high CV-risk patients.',
    tagline: 'Potent LDL control',
    benefits: ['Strong LDL reduction', 'Flexible dosing', 'Outcome-proven statin'],
    clinical: 'ASCOT-LLA & TNT support CV event reduction with atorvastatin.',
    summary: ['Core lipid therapy', 'Evening dose habit', 'Monitor LFTs'],
    cta: 'Anchor lipid plans with Atorvastatin 20mg'
  },
  [`${PREFIX}-AUG-625`]: {
    theme: 'medi',
    problem: 'Community infections often involve beta-lactamase producers.',
    tagline: 'Broad coverage, BID',
    benefits: ['Broad spectrum', 'Trusted brand equity', 'Convenient BID dosing'],
    clinical: 'Widely used for community RTIs and dental infections.',
    summary: ['Go-to oral antibiotic', 'With-food dosing', 'Confirm allergy history'],
    cta: 'Detail Augmentin for mixed community infections'
  },
  [`${PREFIX}-AZI-500`]: {
    theme: 'medi',
    problem: 'Long antibiotic courses hurt outpatient compliance.',
    tagline: '3-day convenience',
    benefits: ['3-day course', 'Excellent compliance', 'Atypical coverage'],
    clinical: 'Short-course azithromycin is standard for many outpatient RTIs.',
    summary: ['High compliance', 'Simple OD regimen', 'Screen QT-risk drugs'],
    cta: 'Offer Azithromycin when compliance matters'
  },
  [`${PREFIX}-PAN-EXT`]: {
    theme: 'pain',
    problem: 'Everyday headache and fever need fast, familiar relief.',
    tagline: 'Fast with caffeine boost',
    benefits: ['Fast onset', 'Familiar OTC brand', 'Flexible dosing'],
    clinical: 'Paracetamol + caffeine shows superior headache relief vs paracetamol alone.',
    summary: ['Everyday pain brand', 'Counsel max daily dose', 'Watch hidden paracetamol'],
    cta: 'Keep Panadol Extra top-of-mind in GP visits'
  },
  [`${PREFIX}-CAL-120`]: {
    theme: 'pain',
    problem: 'Parents need a trusted pediatric fever solution.',
    tagline: 'Pediatric-trusted syrup',
    benefits: ['Pediatric trusted', 'Pleasant taste', 'Clear dosing guidance'],
    clinical: 'Paracetamol remains first-line antipyretic in pediatrics.',
    summary: ['Weight-based dosing', 'Ideal for pediatricians', 'Compare with adult Panadol'],
    cta: 'Present Calpol in every pediatric visit'
  },
  [`${PREFIX}-IBU-400`]: {
    theme: 'pain',
    problem: 'Inflammatory pain often needs more than paracetamol alone.',
    tagline: 'Anti-inflammatory relief',
    benefits: ['Anti-inflammatory + analgesic', 'Familiar NSAID', 'Flexible dosing'],
    clinical: 'Effective when inflammation drives musculoskeletal or dental pain.',
    summary: ['Take with food', 'Screen ulcer risk', 'NSAID option ready'],
    cta: 'Position Ibuprofen when inflammation is key'
  },
  [`${PREFIX}-VITC-1000`]: {
    theme: 'vita',
    problem: 'Seasonal immunity conversations need a simple hero SKU.',
    tagline: 'High-dose daily C',
    benefits: ['High-dose vitamin C', 'Effervescent convenience', 'Campaign friendly'],
    clinical: 'Supports immune function; popular OTC recommendation.',
    summary: ['Seasonal hero', '1 OD in water', 'Bundle with MultiVita'],
    cta: 'Lead with Vita-C in immunity campaigns'
  },
  [`${PREFIX}-MULTI-01`]: {
    theme: 'vita',
    problem: 'Busy adults and convalescent patients miss daily micronutrients.',
    tagline: 'One capsule, every day',
    benefits: ['Complete daily cover', '30-day pack', 'Easy adherence'],
    clinical: 'Supports micronutrient gaps in adults and convalescence.',
    summary: ['Core wellness SKU', 'With breakfast habit', 'Nutrition kit partner'],
    cta: 'Close visits with MultiVita Daily'
  }
};

async function main() {
  await mongoose.connect(env.MONGODB_URI || process.env.MONGODB_URI);
  const company = await mongoose.connection.db.collection('companies').findOne({ name: /Test Company/i });
  if (!company) throw new Error('Test Company not found');
  const companyId = company._id;

  const products = await Product.find({ companyId, sku: { $regex: `^${PREFIX}` } });
  let updated = 0;

  for (const product of products) {
    const focusMeta = FOCUS_BY_SKU[product.sku] || {
      theme: 'medi',
      benefits: ['Effective', 'Convenient', 'Trusted'],
      clinical: 'Supported by clinical practice.',
      summary: ['Strong option', 'Simple message', 'Ready to detail']
    };
    const theme = THEMES[focusMeta.theme] || THEMES.medi;
    const built = buildStory(product.name, focusMeta, theme);

    let pres = await ProductPresentation.findOne({
      companyId,
      productId: product._id,
      isDefault: true,
      status: 'PUBLISHED'
    });

    if (!pres) {
      pres = await ProductPresentation.findOne({ companyId, productId: product._id }).sort({
        updatedAt: -1
      });
    }

    if (!pres) {
      pres = await ProductPresentation.create({
        companyId,
        productId: product._id,
        title: `${PREFIX} ${product.name} Detailing Deck`,
        status: 'PUBLISHED',
        version: 2,
        isDefault: true,
        theme,
        sections: built.sections,
        slides: built.slides,
        publishedAt: new Date()
      });
    } else {
      pres.theme = theme;
      pres.sections = built.sections;
      pres.slides = built.slides;
      pres.status = 'PUBLISHED';
      pres.isDefault = true;
      pres.version = (pres.version || 1) + 1;
      pres.publishedAt = new Date();
      pres.title = `${PREFIX} ${product.name} Detailing Deck`;
    }

    const report = evaluatePresentationQuality(pres.toObject());
    pres.qualityReport = {
      score: report.score,
      checkedAt: report.checkedAt,
      checks: report.checks
    };
    await pres.save();

    product.defaultPresentationId = pres._id;
    product.catalogVersion = (product.catalogVersion || 1) + 1;
    await product.save();
    updated += 1;
    console.log(`Updated ${product.sku} → quality ${report.score}% (${built.slides.length} slides)`);
  }

  console.log(`\nDone. Upgraded ${updated} presentations for Test Company.`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
