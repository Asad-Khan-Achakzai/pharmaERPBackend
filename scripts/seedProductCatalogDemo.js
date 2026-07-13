/**
 * Seed rich Product Catalog demo data for "Test Company".
 *
 * Covers every catalog surface added in the Product Catalog module:
 *   Brands, Taxonomy (Therapy→Area→Class), enriched Products,
 *   Presentations (multi-slide decks), Campaigns, Kits,
 *   Doctor VisitLog product history, Engagement events.
 *
 * Usage:
 *   node scripts/seedProductCatalogDemo.js
 *   node scripts/seedProductCatalogDemo.js --company "Test Company"
 *   node scripts/seedProductCatalogDemo.js --force   # wipe prior CATDEMO-* data first
 *
 * Idempotent: re-running without --force skips if CATDEMO brands already exist.
 * With --force, removes previous CATDEMO catalog rows for that company then reseeds.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const env = require('../src/config/env');

const Company = require('../src/models/Company');
const User = require('../src/models/User');
const Doctor = require('../src/models/Doctor');
const Brand = require('../src/models/Brand');
const ProductTaxonomyNode = require('../src/models/ProductTaxonomyNode');
const Product = require('../src/models/Product');
const ProductPresentation = require('../src/models/ProductPresentation');
const CatalogCampaign = require('../src/models/CatalogCampaign');
const ProductKit = require('../src/models/ProductKit');
const ProductEngagementEvent = require('../src/models/ProductEngagementEvent');
const VisitLog = require('../src/models/VisitLog');
const { PRODUCT_TAXONOMY_KIND } = require('../src/constants/enums');

const PREFIX = 'CATDEMO';

function argValue(flag, fallback) {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const FORCE = process.argv.includes('--force');
const COMPANY_NAME = argValue('--company', 'Test Company');

function oid() {
  return new mongoose.Types.ObjectId();
}

async function wipeDemo(companyId) {
  const brands = await Brand.find({ companyId, code: { $regex: `^${PREFIX}` } }).select('_id');
  const brandIds = brands.map((b) => b._id);
  const products = await Product.find({
    companyId,
    $or: [{ sku: { $regex: `^${PREFIX}` } }, { brandId: { $in: brandIds } }]
  }).select('_id');
  const productIds = products.map((p) => p._id);

  await ProductPresentation.deleteMany({
    companyId,
    $or: [{ productId: { $in: productIds } }, { title: { $regex: PREFIX } }]
  });
  await CatalogCampaign.deleteMany({ companyId, code: { $regex: `^${PREFIX}` } });
  await ProductKit.deleteMany({ companyId, code: { $regex: `^${PREFIX}` } });
  await ProductEngagementEvent.deleteMany({
    companyId,
    clientEventId: { $regex: `^${PREFIX}` }
  });
  await VisitLog.deleteMany({
    companyId,
    notes: { $regex: `\\[${PREFIX}\\]` }
  });
  await Product.deleteMany({ companyId, sku: { $regex: `^${PREFIX}` } });
  await Brand.deleteMany({ companyId, code: { $regex: `^${PREFIX}` } });
  await ProductTaxonomyNode.deleteMany({ companyId, code: { $regex: `^${PREFIX}` } });

  console.log(
    `Wiped prior demo: brands=${brandIds.length} products=${productIds.length}`
  );
}

async function createTaxonomy(companyId, userId) {
  const therapyDefs = [
    {
      name: 'Cardiology',
      code: `${PREFIX}-THERAPY-CARDIO`,
      areas: [
        {
          name: 'Hypertension',
          code: `${PREFIX}-AREA-HTN`,
          classes: [
            { name: 'ACE Inhibitors', code: `${PREFIX}-CLASS-ACE` },
            { name: 'ARBs', code: `${PREFIX}-CLASS-ARB` }
          ]
        },
        {
          name: 'Dyslipidemia',
          code: `${PREFIX}-AREA-LIPID`,
          classes: [{ name: 'Statins', code: `${PREFIX}-CLASS-STATIN` }]
        }
      ]
    },
    {
      name: 'Infectious Disease',
      code: `${PREFIX}-THERAPY-ID`,
      areas: [
        {
          name: 'Antibiotics',
          code: `${PREFIX}-AREA-ABX`,
          classes: [
            { name: 'Penicillins', code: `${PREFIX}-CLASS-PEN` },
            { name: 'Macrolides', code: `${PREFIX}-CLASS-MAC` }
          ]
        }
      ]
    },
    {
      name: 'Pain & Analgesia',
      code: `${PREFIX}-THERAPY-PAIN`,
      areas: [
        {
          name: 'Fever & Pain',
          code: `${PREFIX}-AREA-FEVER`,
          classes: [
            { name: 'Paracetamol', code: `${PREFIX}-CLASS-PCM` },
            { name: 'NSAIDs', code: `${PREFIX}-CLASS-NSAID` }
          ]
        }
      ]
    },
    {
      name: 'Vitamins & Nutrition',
      code: `${PREFIX}-THERAPY-VIT`,
      areas: [
        {
          name: 'Supplements',
          code: `${PREFIX}-AREA-SUPP`,
          classes: [{ name: 'Multivitamins', code: `${PREFIX}-CLASS-MULTI` }]
        }
      ]
    }
  ];

  const classByCode = {};

  for (const t of therapyDefs) {
    const therapy = await ProductTaxonomyNode.create({
      companyId,
      name: t.name,
      code: t.code,
      kind: PRODUCT_TAXONOMY_KIND.THERAPY,
      parentId: null,
      materializedPath: '/',
      depth: 0,
      sortOrder: 0,
      isActive: true,
      createdBy: userId
    });
    therapy.materializedPath = `/${therapy._id}/`;
    await therapy.save();

    for (const a of t.areas) {
      const area = await ProductTaxonomyNode.create({
        companyId,
        name: a.name,
        code: a.code,
        kind: PRODUCT_TAXONOMY_KIND.AREA,
        parentId: therapy._id,
        materializedPath: '/',
        depth: 1,
        sortOrder: 0,
        isActive: true,
        createdBy: userId
      });
      area.materializedPath = `${therapy.materializedPath}${area._id}/`;
      await area.save();

      for (const c of a.classes) {
        const cls = await ProductTaxonomyNode.create({
          companyId,
          name: c.name,
          code: c.code,
          kind: PRODUCT_TAXONOMY_KIND.CLASS,
          parentId: area._id,
          materializedPath: '/',
          depth: 2,
          sortOrder: 0,
          isActive: true,
          createdBy: userId
        });
        cls.materializedPath = `${area.materializedPath}${cls._id}/`;
        await cls.save();
        classByCode[c.code] = {
          id: cls._id,
          labels: [t.name, a.name, c.name]
        };
      }
    }
  }

  return classByCode;
}

function presentationSlides(productName, focus) {
  return [
    {
      slideId: oid(),
      sortOrder: 0,
      type: 'IMAGE',
      title: `${productName}`,
      body: 'Product hero visual (demo — attach real media in admin)',
      assetId: null,
      durationHintSec: 8,
      isOfflineEligible: true
    },
    {
      slideId: oid(),
      sortOrder: 1,
      type: 'BENEFITS',
      title: 'Key Benefits',
      body: focus.benefits,
      assetId: null,
      durationHintSec: 20,
      isOfflineEligible: true
    },
    {
      slideId: oid(),
      sortOrder: 2,
      type: 'CLINICAL',
      title: 'Clinical Evidence',
      body: focus.clinical,
      assetId: null,
      durationHintSec: 25,
      isOfflineEligible: true
    },
    {
      slideId: oid(),
      sortOrder: 3,
      type: 'RICH_TEXT',
      title: 'Dosage at a Glance',
      body: focus.dosage,
      assetId: null,
      durationHintSec: 15,
      isOfflineEligible: true
    },
    {
      slideId: oid(),
      sortOrder: 4,
      type: 'REMINDER',
      title: 'Detailing Reminder',
      body: focus.reminder,
      assetId: null,
      durationHintSec: 10,
      isOfflineEligible: true
    },
    {
      slideId: oid(),
      sortOrder: 5,
      type: 'SUMMARY',
      title: 'Summary',
      body: focus.summary,
      assetId: null,
      durationHintSec: 12,
      isOfflineEligible: true
    }
  ];
}

async function main() {
  const uri = env.MONGODB_URI || process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI missing');
  await mongoose.connect(uri);

  let company = await Company.findOne({
    name: { $regex: new RegExp(`^${COMPANY_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
  });
  if (!company) {
    company = await Company.findOne({ name: /test\s*comp/i });
  }
  if (!company) {
    console.error(`Company not found: "${COMPANY_NAME}"`);
    process.exit(1);
  }

  const companyId = company._id;
  console.log(`Seeding catalog for: ${company.name} (${companyId})`);

  const existingDemo = await Brand.countDocuments({
    companyId,
    code: { $regex: `^${PREFIX}` }
  });
  if (existingDemo && !FORCE) {
    console.log(
      `Demo data already present (${existingDemo} brands). Re-run with --force to recreate.`
    );
    await mongoose.disconnect();
    return;
  }
  if (existingDemo && FORCE) {
    await wipeDemo(companyId);
  }

  const adminUser =
    (await User.findOne({ companyId, email: /admin|saleem|zalan/i }).select('_id name')) ||
    (await User.findOne({ companyId }).select('_id name'));
  const userId = adminUser?._id || null;
  console.log(`Acting user: ${adminUser?.name || 'system'} (${userId})`);

  // —— Brands ——
  const brandDefs = [
    { name: 'CardioLife', code: `${PREFIX}-BRAND-CARDIO`, description: 'Cardiovascular specialty line' },
    { name: 'MediCare Pharma', code: `${PREFIX}-BRAND-MEDI`, description: 'Anti-infectives & general medicines' },
    { name: 'VitaPlus', code: `${PREFIX}-BRAND-VITA`, description: 'Vitamins and nutritional supplements' },
    { name: 'PainFree Labs', code: `${PREFIX}-BRAND-PAIN`, description: 'Analgesics and antipyretics' }
  ];
  const brands = {};
  for (const b of brandDefs) {
    const doc = await Brand.create({
      companyId,
      ...b,
      isActive: true,
      createdBy: userId
    });
    brands[b.code] = doc;
  }
  console.log(`Brands: ${Object.keys(brands).length}`);

  // —— Taxonomy ——
  const classByCode = await createTaxonomy(companyId, userId);
  console.log(`Taxonomy classes: ${Object.keys(classByCode).length}`);

  // —— Products ——
  const productDefs = [
    {
      name: 'Lisinopril 10mg',
      sku: `${PREFIX}-LIS-10`,
      brand: `${PREFIX}-BRAND-CARDIO`,
      classCode: `${PREFIX}-CLASS-ACE`,
      genericName: 'Lisinopril',
      strength: '10mg',
      dosageForm: 'Tablet',
      packSize: '2x10',
      manufacturer: 'CardioLife Pharma',
      composition: 'Lisinopril 10mg',
      description: 'ACE inhibitor for hypertension and heart failure.',
      indications: 'Essential hypertension; heart failure; post-MI.',
      contraindications: 'History of angioedema with ACE inhibitors; pregnancy.',
      dosageInstructions: 'Usual adult dose 10mg once daily; titrate as needed.',
      sideEffects: 'Dry cough, dizziness, hyperkalemia (rare).',
      storageInstructions: 'Store below 30°C. Protect from moisture.',
      mrp: 450,
      tp: 360,
      casting: 180,
      distributorPrice: 320,
      isSampleEligible: true,
      sampleUnitLabel: 'strip',
      sortOrder: 1,
      focus: {
        benefits: '• Once-daily dosing\n• Proven BP reduction\n• Cardiac protection post-MI',
        clinical: 'HOPE & ATLAS trials support ACE-I outcomes in high-risk patients.',
        dosage: 'Start 10mg OD. Max 40mg/day. Reduce in renal impairment.',
        reminder: 'Ask about cough. Check K+ and creatinine if co-prescribed with diuretics.',
        summary: 'Reliable first-line ACE inhibitor — CardioLife flagship.'
      }
    },
    {
      name: 'Losartan 50mg',
      sku: `${PREFIX}-LOS-50`,
      brand: `${PREFIX}-BRAND-CARDIO`,
      classCode: `${PREFIX}-CLASS-ARB`,
      genericName: 'Losartan Potassium',
      strength: '50mg',
      dosageForm: 'Tablet',
      packSize: '2x14',
      manufacturer: 'CardioLife Pharma',
      composition: 'Losartan Potassium 50mg',
      description: 'ARB for hypertension; cough-sparing alternative to ACE-I.',
      indications: 'Hypertension; diabetic nephropathy; stroke risk reduction.',
      contraindications: 'Pregnancy; severe hepatic impairment.',
      dosageInstructions: '50mg once daily; may increase to 100mg.',
      sideEffects: 'Dizziness, hyperkalemia, rare angioedema.',
      storageInstructions: 'Store below 30°C.',
      mrp: 520,
      tp: 416,
      casting: 210,
      distributorPrice: 380,
      isSampleEligible: true,
      sampleUnitLabel: 'strip',
      sortOrder: 2,
      focus: {
        benefits: '• No ACE cough\n• Renal protection in T2DM\n• Once daily',
        clinical: 'LIFE trial: losartan reduced stroke vs atenolol in hypertensives.',
        dosage: '50–100mg OD. Consider 25mg start in volume-depleted patients.',
        reminder: 'Ideal switch for patients intolerant to ACE cough.',
        summary: 'Preferred ARB for cough-intolerant hypertensives.'
      }
    },
    {
      name: 'Atorvastatin 20mg',
      sku: `${PREFIX}-ATO-20`,
      brand: `${PREFIX}-BRAND-CARDIO`,
      classCode: `${PREFIX}-CLASS-STATIN`,
      genericName: 'Atorvastatin Calcium',
      strength: '20mg',
      dosageForm: 'Tablet',
      packSize: '1x10',
      manufacturer: 'CardioLife Pharma',
      composition: 'Atorvastatin 20mg',
      description: 'HMG-CoA reductase inhibitor for dyslipidemia.',
      indications: 'Hypercholesterolemia; mixed dyslipidemia; CV risk reduction.',
      contraindications: 'Active liver disease; pregnancy; breastfeeding.',
      dosageInstructions: '10–80mg once daily; usual start 20mg.',
      sideEffects: 'Myalgia, elevated LFTs; rare rhabdomyolysis.',
      storageInstructions: 'Store below 25°C.',
      mrp: 380,
      tp: 304,
      casting: 140,
      distributorPrice: 280,
      isSampleEligible: false,
      sortOrder: 3,
      focus: {
        benefits: '• Potent LDL reduction\n• Flexible dosing\n• Outcome-proven statin',
        clinical: 'ASCOT-LLA & TNT demonstrate CV event reduction with atorvastatin.',
        dosage: 'Evening dose preferred. Monitor LFTs at baseline and 12 weeks.',
        reminder: 'Ask about muscle pain and interacting drugs (e.g. macrolides).',
        summary: 'Core lipid therapy for high CV-risk patients.'
      }
    },
    {
      name: 'Augmentin 625mg',
      sku: `${PREFIX}-AUG-625`,
      brand: `${PREFIX}-BRAND-MEDI`,
      classCode: `${PREFIX}-CLASS-PEN`,
      genericName: 'Amoxicillin + Clavulanic Acid',
      strength: '500/125mg',
      dosageForm: 'Tablet',
      packSize: '1x6',
      manufacturer: 'MediCare Pharma',
      composition: 'Amoxicillin 500mg + Clavulanic Acid 125mg',
      description: 'Broad-spectrum penicillin with beta-lactamase inhibitor.',
      indications: 'RTI, UTI, skin & soft tissue infections, dental infections.',
      contraindications: 'Penicillin allergy; history of cholestatic jaundice with amox-clav.',
      dosageInstructions: '1 tablet every 12 hours with food for 5–7 days.',
      sideEffects: 'Diarrhea, nausea, rash; rare hepatic effects.',
      storageInstructions: 'Store below 25°C. Keep dry.',
      mrp: 290,
      tp: 232,
      casting: 95,
      distributorPrice: 210,
      isSampleEligible: true,
      sampleUnitLabel: 'tablet',
      sortOrder: 4,
      focus: {
        benefits: '• Broad coverage incl. beta-lactamase producers\n• Trusted brand equity\n• BID dosing',
        clinical: 'Widely studied for community RTIs and dental abscess.',
        dosage: '625mg BID with meals. Adjust in renal impairment.',
        reminder: 'Confirm penicillin allergy history before detailing.',
        summary: 'Go-to oral antibiotic for mixed community infections.'
      }
    },
    {
      name: 'Azithromycin 500mg',
      sku: `${PREFIX}-AZI-500`,
      brand: `${PREFIX}-BRAND-MEDI`,
      classCode: `${PREFIX}-CLASS-MAC`,
      genericName: 'Azithromycin',
      strength: '500mg',
      dosageForm: 'Tablet',
      packSize: '1x3',
      manufacturer: 'MediCare Pharma',
      composition: 'Azithromycin 500mg',
      description: 'Macrolide antibiotic — short course convenience.',
      indications: 'Community RTI, atypical pneumonia, soft tissue infections.',
      contraindications: 'Macrolide hypersensitivity; caution in QT prolongation.',
      dosageInstructions: '500mg once daily for 3 days.',
      sideEffects: 'GI upset, headache; rare QT prolongation.',
      storageInstructions: 'Store below 30°C.',
      mrp: 240,
      tp: 192,
      casting: 80,
      distributorPrice: 175,
      isSampleEligible: true,
      sampleUnitLabel: 'tablet',
      sortOrder: 5,
      focus: {
        benefits: '• 3-day course\n• Excellent compliance\n• Atypical coverage',
        clinical: 'Short-course azithromycin is standard for many outpatient RTIs.',
        dosage: '500mg OD x 3 days. Take 1h before or 2h after meals if GI upset.',
        reminder: 'Screen for QT-risk drugs and severe hepatic disease.',
        summary: 'High-compliance macrolide for busy outpatient practice.'
      }
    },
    {
      name: 'Panadol Extra',
      sku: `${PREFIX}-PAN-EXT`,
      brand: `${PREFIX}-BRAND-PAIN`,
      classCode: `${PREFIX}-CLASS-PCM`,
      genericName: 'Paracetamol + Caffeine',
      strength: '500mg/65mg',
      dosageForm: 'Tablet',
      packSize: '2x10',
      manufacturer: 'PainFree Labs',
      composition: 'Paracetamol 500mg + Caffeine 65mg',
      description: 'Fast-acting analgesic for headache and mild-moderate pain.',
      indications: 'Headache, toothache, musculoskeletal pain, fever.',
      contraindications: 'Severe hepatic impairment; known hypersensitivity.',
      dosageInstructions: '1–2 tablets every 4–6 hours; max 8 tablets/day.',
      sideEffects: 'Rare at therapeutic doses; hepatotoxicity in overdose.',
      storageInstructions: 'Store below 30°C.',
      mrp: 180,
      tp: 144,
      casting: 55,
      distributorPrice: 130,
      isSampleEligible: true,
      sampleUnitLabel: 'strip',
      sortOrder: 6,
      focus: {
        benefits: '• Fast onset with caffeine boost\n• Familiar OTC brand\n• Flexible dosing',
        clinical: 'Paracetamol + caffeine combinations show superior headache relief vs paracetamol alone.',
        dosage: '1–2 tabs q4–6h. Counsel on max daily dose and alcohol risk.',
        reminder: 'Check concurrent cold/flu products for hidden paracetamol.',
        summary: 'Everyday pain & fever brand — high detailing frequency.'
      }
    },
    {
      name: 'Calpol 120mg/5ml',
      sku: `${PREFIX}-CAL-120`,
      brand: `${PREFIX}-BRAND-PAIN`,
      classCode: `${PREFIX}-CLASS-PCM`,
      genericName: 'Paracetamol',
      strength: '120mg/5ml',
      dosageForm: 'Syrup',
      packSize: '60ml',
      manufacturer: 'PainFree Labs',
      composition: 'Paracetamol 120mg/5ml',
      description: 'Pediatric antipyretic and analgesic syrup.',
      indications: 'Fever and mild pain in infants and children.',
      contraindications: 'Severe liver disease.',
      dosageInstructions: 'Weight-based dosing; typically 10–15mg/kg every 4–6 hours.',
      sideEffects: 'Rare at correct dose.',
      storageInstructions: 'Store below 25°C. Shake well.',
      mrp: 160,
      tp: 128,
      casting: 48,
      distributorPrice: 115,
      isSampleEligible: true,
      sampleUnitLabel: 'bottle',
      sortOrder: 7,
      focus: {
        benefits: '• Pediatric-trusted\n• Pleasant taste\n• Clear dosing guidance',
        clinical: 'Paracetamol remains first-line antipyretic in pediatrics.',
        dosage: 'Use dosing syringe. Reinforce weight-based calculation with parents.',
        reminder: 'Ideal for pediatrician detailing — compare vs adult Panadol Extra.',
        summary: 'Pediatric fever care staple — pair with Panadol Extra in compare mode.'
      }
    },
    {
      name: 'Ibuprofen 400mg',
      sku: `${PREFIX}-IBU-400`,
      brand: `${PREFIX}-BRAND-PAIN`,
      classCode: `${PREFIX}-CLASS-NSAID`,
      genericName: 'Ibuprofen',
      strength: '400mg',
      dosageForm: 'Tablet',
      packSize: '2x10',
      manufacturer: 'PainFree Labs',
      composition: 'Ibuprofen 400mg',
      description: 'NSAID for inflammatory pain and fever.',
      indications: 'Musculoskeletal pain, dental pain, dysmenorrhea, fever.',
      contraindications: 'Active peptic ulcer; severe heart failure; 3rd trimester pregnancy.',
      dosageInstructions: '400mg every 6–8 hours with food; max 1200mg/day OTC.',
      sideEffects: 'GI upset, rare GI bleed; fluid retention.',
      storageInstructions: 'Store below 30°C.',
      mrp: 210,
      tp: 168,
      casting: 70,
      distributorPrice: 150,
      isSampleEligible: false,
      sortOrder: 8,
      focus: {
        benefits: '• Anti-inflammatory + analgesic\n• Familiar NSAID\n• Flexible dosing',
        clinical: 'Effective for inflammatory pain when paracetamol alone is insufficient.',
        dosage: 'Take with food. Avoid in high CV/GI risk without gastroprotection.',
        reminder: 'Screen for ulcer history and concurrent anticoagulants.',
        summary: 'NSAID option when inflammation drives pain.'
      }
    },
    {
      name: 'Vita-C 1000mg',
      sku: `${PREFIX}-VITC-1000`,
      brand: `${PREFIX}-BRAND-VITA`,
      classCode: `${PREFIX}-CLASS-MULTI`,
      genericName: 'Ascorbic Acid',
      strength: '1000mg',
      dosageForm: 'Effervescent Tablet',
      packSize: '1x10',
      manufacturer: 'VitaPlus',
      composition: 'Vitamin C 1000mg',
      description: 'High-dose vitamin C for immunity support.',
      indications: 'Vitamin C deficiency; adjunct in colds; antioxidant support.',
      contraindications: 'Hyperoxaluria caution; kidney stones history — counsel.',
      dosageInstructions: '1 tablet daily dissolved in water.',
      sideEffects: 'GI upset at high doses.',
      storageInstructions: 'Keep tube tightly closed; protect from moisture.',
      mrp: 320,
      tp: 256,
      casting: 110,
      distributorPrice: 230,
      isSampleEligible: true,
      sampleUnitLabel: 'tube',
      sortOrder: 9,
      focus: {
        benefits: '• High-dose C\n• Effervescent convenience\n• Seasonal campaign friendly',
        clinical: 'Supports immune function; popular OTC recommendation.',
        dosage: '1 OD in water. Advise hydration.',
        reminder: 'Feature in July / seasonal immunity campaigns.',
        summary: 'Seasonal hero SKU for VitaPlus detailing.'
      }
    },
    {
      name: 'MultiVita Daily',
      sku: `${PREFIX}-MULTI-01`,
      brand: `${PREFIX}-BRAND-VITA`,
      classCode: `${PREFIX}-CLASS-MULTI`,
      genericName: 'Multivitamin + Minerals',
      strength: 'OD',
      dosageForm: 'Capsule',
      packSize: '1x30',
      manufacturer: 'VitaPlus',
      composition: 'Multivitamin with minerals',
      description: 'Once-daily multivitamin for general wellness.',
      indications: 'Nutritional supplementation; convalescence.',
      contraindications: 'Hypersensitivity to any component.',
      dosageInstructions: '1 capsule daily with food.',
      sideEffects: 'Mild GI discomfort (rare).',
      storageInstructions: 'Store below 25°C.',
      mrp: 550,
      tp: 440,
      casting: 200,
      distributorPrice: 400,
      isSampleEligible: true,
      sampleUnitLabel: 'pack',
      sortOrder: 10,
      focus: {
        benefits: '• Complete daily cover\n• 30-day pack\n• Easy adherence',
        clinical: 'Supports micronutrient gaps in busy adults and convalescent patients.',
        dosage: '1 capsule with breakfast.',
        reminder: 'Bundle with Vita-C in Nutrition Kit.',
        summary: 'Core wellness SKU for GP and physician detailing.'
      }
    }
  ];

  const products = {};
  let catalogVersion = 10;
  for (const p of productDefs) {
    const brand = brands[p.brand];
    const tax = classByCode[p.classCode];
    const { focus, brand: _b, classCode: _c, ...fields } = p;
    const doc = await Product.create({
      companyId,
      ...fields,
      brandId: brand._id,
      taxonomyNodeId: tax.id,
      taxonomyPathLabels: tax.labels,
      catalogVersion: catalogVersion++,
      isActive: true,
      createdBy: userId
    });
    products[p.sku] = { doc, focus };
  }
  console.log(`Products: ${Object.keys(products).length}`);

  // Enrich legacy products lightly so they appear in catalog too
  const legacy = await Product.find({
    companyId,
    sku: { $not: { $regex: `^${PREFIX}` } },
    isDeleted: { $ne: true }
  });
  for (const lp of legacy) {
    if (!lp.genericName && lp.composition) lp.genericName = lp.composition;
    if (!lp.catalogVersion) lp.catalogVersion = catalogVersion++;
    if (!lp.brandId) lp.brandId = brands[`${PREFIX}-BRAND-MEDI`]._id;
    await lp.save();
  }
  console.log(`Legacy products touched: ${legacy.length}`);

  // —— Presentations (published defaults) ——
  let presentationCount = 0;
  for (const [sku, { doc, focus }] of Object.entries(products)) {
    const slides = presentationSlides(doc.name, focus);
    const pres = await ProductPresentation.create({
      companyId,
      productId: doc._id,
      title: `${PREFIX} ${doc.name} Detailing Deck`,
      status: 'PUBLISHED',
      version: 1,
      isDefault: true,
      slides,
      publishedAt: new Date(),
      createdBy: userId,
      updatedBy: userId
    });
    doc.defaultPresentationId = pres._id;
    doc.catalogVersion = catalogVersion++;
    await doc.save();
    presentationCount += 1;

    // Also create one DRAFT for Lisinopril so Marketing can see draft vs published
    if (sku === `${PREFIX}-LIS-10`) {
      await ProductPresentation.create({
        companyId,
        productId: doc._id,
        title: `${PREFIX} Lisinopril Draft v2 (unpublished)`,
        status: 'DRAFT',
        version: 1,
        isDefault: false,
        slides: presentationSlides(doc.name, {
          ...focus,
          benefits: 'DRAFT — new benefits copy under review'
        }),
        createdBy: userId
      });
    }
  }
  console.log(`Presentations published: ${presentationCount} (+1 draft)`);

  // —— Campaigns ——
  const now = new Date();
  const in30 = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const ago7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const campaignDefs = [
    {
      name: 'July Featured Products',
      code: `${PREFIX}-CAMP-FEATURED`,
      type: 'FEATURED',
      description: 'Priority detailing SKUs for this month',
      productSkus: [`${PREFIX}-LIS-10`, `${PREFIX}-AUG-625`, `${PREFIX}-PAN-EXT`],
      sortOrder: 1
    },
    {
      name: 'New Launches — Cardio',
      code: `${PREFIX}-CAMP-NEW`,
      type: 'NEW_LAUNCH',
      description: 'Newly highlighted cardiovascular line',
      productSkus: [`${PREFIX}-LOS-50`, `${PREFIX}-ATO-20`],
      sortOrder: 2
    },
    {
      name: 'Seasonal Immunity Drive',
      code: `${PREFIX}-CAMP-SEASON`,
      type: 'SEASONAL',
      description: 'Vitamins push for seasonal detailing',
      productSkus: [`${PREFIX}-VITC-1000`, `${PREFIX}-MULTI-01`],
      sortOrder: 3
    },
    {
      name: 'Pain Relief Collection',
      code: `${PREFIX}-CAMP-COLL`,
      type: 'COLLECTION',
      description: 'Analgesic collection for GP visits',
      productSkus: [`${PREFIX}-PAN-EXT`, `${PREFIX}-CAL-120`, `${PREFIX}-IBU-400`],
      sortOrder: 4
    }
  ];

  for (const c of campaignDefs) {
    await CatalogCampaign.create({
      companyId,
      name: c.name,
      code: c.code,
      type: c.type,
      description: c.description,
      productIds: c.productSkus.map((s) => products[s].doc._id),
      startAt: ago7,
      endAt: in30,
      isActive: true,
      sortOrder: c.sortOrder,
      createdBy: userId
    });
  }
  console.log(`Campaigns: ${campaignDefs.length}`);

  // —— Kits ——
  const kitDefs = [
    {
      name: 'Respiratory Kit',
      code: `${PREFIX}-KIT-RESP`,
      description: 'Present antibiotics together during RTI season',
      productSkus: [`${PREFIX}-AUG-625`, `${PREFIX}-AZI-500`]
    },
    {
      name: 'Cardio Essentials Kit',
      code: `${PREFIX}-KIT-CARDIO`,
      description: 'Hypertension + lipid core detailing set',
      productSkus: [`${PREFIX}-LIS-10`, `${PREFIX}-LOS-50`, `${PREFIX}-ATO-20`]
    },
    {
      name: 'Nutrition Kit',
      code: `${PREFIX}-KIT-NUTRI`,
      description: 'Wellness bundle for GP and physician visits',
      productSkus: [`${PREFIX}-VITC-1000`, `${PREFIX}-MULTI-01`]
    }
  ];
  const kits = {};
  for (const k of kitDefs) {
    const doc = await ProductKit.create({
      companyId,
      name: k.name,
      code: k.code,
      description: k.description,
      productIds: k.productSkus.map((s) => products[s].doc._id),
      isActive: true,
      sortOrder: 0,
      createdBy: userId
    });
    kits[k.code] = doc;
  }
  console.log(`Kits: ${Object.keys(kits).length}`);

  // —— Doctor product history via VisitLog ——
  const doctors = await Doctor.find({ companyId, isDeleted: { $ne: true } })
    .select('_id name specialization')
    .limit(8)
    .lean();
  const reps = await User.find({ companyId }).select('_id name').limit(5).lean();
  const repId = reps[0]?._id || userId;

  let visitCount = 0;
  if (doctors.length && repId) {
    const historyPlan = [
      {
        doctor: doctors[0],
        products: [`${PREFIX}-PAN-EXT`, `${PREFIX}-CAL-120`],
        primary: `${PREFIX}-PAN-EXT`,
        daysAgo: 3,
        notes: `[${PREFIX}] Discussed Panadol Extra vs Calpol for family practice`
      },
      {
        doctor: doctors[0],
        products: [`${PREFIX}-PAN-EXT`, `${PREFIX}-AUG-625`],
        primary: `${PREFIX}-AUG-625`,
        daysAgo: 18,
        notes: `[${PREFIX}] Follow-up; antibiotic for RTI`
      },
      {
        doctor: doctors[1] || doctors[0],
        products: [`${PREFIX}-CAL-120`, `${PREFIX}-VITC-1000`],
        primary: `${PREFIX}-CAL-120`,
        daysAgo: 5,
        notes: `[${PREFIX}] Pediatric fever + vitamin support`
      },
      {
        doctor: doctors[2] || doctors[0],
        products: [`${PREFIX}-LIS-10`, `${PREFIX}-ATO-20`],
        primary: `${PREFIX}-LIS-10`,
        daysAgo: 2,
        notes: `[${PREFIX}] Cardio detailing — ACE + statin`,
        kit: `${PREFIX}-KIT-CARDIO`
      },
      {
        doctor: doctors[3] || doctors[0],
        products: [`${PREFIX}-AUG-625`, `${PREFIX}-AZI-500`],
        primary: `${PREFIX}-AZI-500`,
        daysAgo: 9,
        notes: `[${PREFIX}] Respiratory kit presented`,
        kit: `${PREFIX}-KIT-RESP`
      },
      {
        doctor: doctors[4] || doctors[0],
        products: [`${PREFIX}-LOS-50`],
        primary: `${PREFIX}-LOS-50`,
        daysAgo: 1,
        notes: `[${PREFIX}] Switched patient off ACE due to cough`
      }
    ];

    for (const h of historyPlan) {
      const visitTime = new Date(Date.now() - h.daysAgo * 24 * 60 * 60 * 1000);
      const pIds = h.products.map((s) => products[s].doc._id);
      const primaryId = products[h.primary].doc._id;
      const sessions = h.products.map((s) => ({
        productId: products[s].doc._id,
        presentationId: products[s].doc.defaultPresentationId,
        presentationVersion: 1,
        completed: true,
        startedAt: new Date(visitTime.getTime() - 10 * 60 * 1000),
        endedAt: visitTime
      }));

      await VisitLog.create({
        companyId,
        planItemId: null,
        employeeId: repId,
        doctorId: h.doctor._id,
        visitTime,
        checkInTime: new Date(visitTime.getTime() - 25 * 60 * 1000),
        checkOutTime: visitTime,
        notes: h.notes,
        orderTaken: false,
        productsDiscussed: pIds,
        primaryProductId: primaryId,
        presentedKitIds: h.kit ? [kits[h.kit]._id] : [],
        presentationSessions: sessions,
        samplesQty: products[h.primary].doc.isSampleEligible ? 2 : null,
        samplesGiven: products[h.primary].doc.isSampleEligible
          ? `2 ${products[h.primary].doc.sampleUnitLabel || 'units'} ${products[h.primary].doc.name}`
          : null,
        createdBy: repId
      });
      visitCount += 1;
    }
  }
  console.log(`VisitLog history rows: ${visitCount} (doctors sampled: ${doctors.length})`);

  // —— Engagement events ——
  const engagementTypes = [
    'CATALOG_VIEW',
    'PRODUCT_VIEW',
    'COMPARE_OPEN',
    'PRESENTATION_START',
    'SLIDE_VIEW',
    'PRESENTATION_COMPLETE',
    'CAMPAIGN_SECTION_VIEW',
    'CAMPAIGN_PRODUCT_CLICK',
    'KIT_VIEW',
    'FAVORITE_ADD',
    'SEARCH',
    'SEARCH_CLICK'
  ];
  let engCount = 0;
  if (repId) {
    const sampleProduct = products[`${PREFIX}-PAN-EXT`].doc;
    const sampleCampaign = await CatalogCampaign.findOne({
      companyId,
      code: `${PREFIX}-CAMP-FEATURED`
    });
    const sampleKit = kits[`${PREFIX}-KIT-RESP`];

    for (let i = 0; i < engagementTypes.length; i++) {
      const eventType = engagementTypes[i];
      await ProductEngagementEvent.create({
        companyId,
        userId: repId,
        clientEventId: `${PREFIX}-evt-${i}-${Date.now()}`,
        eventType,
        occurredAt: new Date(Date.now() - i * 60 * 60 * 1000),
        productId: sampleProduct._id,
        presentationId: sampleProduct.defaultPresentationId,
        slideId: null,
        campaignId: sampleCampaign?._id || null,
        kitId: sampleKit?._id || null,
        doctorId: doctors[0]?._id || null,
        meta: { source: 'seed', demo: true, query: eventType === 'SEARCH' ? 'panadol' : undefined }
      });
      engCount += 1;
    }

    // Extra views for ranking
    for (const sku of [`${PREFIX}-LIS-10`, `${PREFIX}-AUG-625`, `${PREFIX}-VITC-1000`]) {
      await ProductEngagementEvent.create({
        companyId,
        userId: repId,
        clientEventId: `${PREFIX}-view-${sku}-${Date.now()}`,
        eventType: 'PRODUCT_VIEW',
        occurredAt: new Date(),
        productId: products[sku].doc._id,
        meta: { source: 'seed' }
      });
      engCount += 1;
    }
  }
  console.log(`Engagement events: ${engCount}`);

  console.log('\n===== DEMO CATALOG READY =====');
  console.log(`Company: ${company.name}`);
  console.log('Try on Web:');
  console.log('  • Products list / detail / Presentations tab / Present preview');
  console.log('  • Brands, Taxonomy tree, Campaigns, Kits');
  console.log('  • Compare Panadol Extra vs Calpol 120mg/5ml');
  console.log('Try on Mobile:');
  console.log('  • More → Product Catalog (campaigns, browse, favorites)');
  console.log('  • Open product → Present (swipe detailing deck)');
  console.log('  • Start visit → Previously Presented on seeded doctors');
  console.log(`Seeded doctors with history: ${doctors.slice(0, 5).map((d) => d.name).join(', ')}`);
  console.log('==============================\n');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
