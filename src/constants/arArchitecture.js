/**
 * Enterprise AR architecture freeze (Option B).
 *
 * Application SoT: Collection.allocations + ReturnRecord.allocations + OrderAmendment.allocations
 * Money SoT: Pharmacy Ledger amounts (immutable)
 * Open / OC / Reports / payment status: derived from deliveries − document allocations
 * Ledger.meta.deliveryId: non-authoritative for open
 *
 * AR_OPEN_ENGINE:
 *   document — production open engine (default)
 *   legacy   — rollback to ledger-meta FIFO (+ historical return map)
 *   shadow   — compute document open for reads; also log divergence vs legacy
 */
const AR_OPEN_ENGINE = {
  DOCUMENT: 'document',
  LEGACY: 'legacy',
  SHADOW: 'shadow'
};

const INVARIANT_EPS = 0.01;

const resolveArOpenEngine = () => {
  const raw = String(process.env.AR_OPEN_ENGINE || AR_OPEN_ENGINE.DOCUMENT)
    .trim()
    .toLowerCase();
  if (raw === AR_OPEN_ENGINE.LEGACY) return AR_OPEN_ENGINE.LEGACY;
  if (raw === AR_OPEN_ENGINE.SHADOW) return AR_OPEN_ENGINE.SHADOW;
  return AR_OPEN_ENGINE.DOCUMENT;
};

const useDocumentOpenEngine = () => {
  const mode = resolveArOpenEngine();
  return mode === AR_OPEN_ENGINE.DOCUMENT || mode === AR_OPEN_ENGINE.SHADOW;
};

module.exports = {
  AR_OPEN_ENGINE,
  INVARIANT_EPS,
  resolveArOpenEngine,
  useDocumentOpenEngine
};
