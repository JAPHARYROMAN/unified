import { Injectable } from "@nestjs/common";

/**
 * In-process atomic counters for chain transaction observability.
 * Exposed via GET /admin/ops/metrics.
 *
 * These are process-local counters — they reset on restart.
 * For persistent metrics, wire these to a Prometheus push-gateway or
 * a time-series DB in a future iteration.
 */
@Injectable()
export class TxMetricsService {
  private _txSubmittedTotal = 0;
  private _txConfirmedTotal = 0;
  private _txFailedTotal = 0;
  private _txDlqTotal = 0;
  private _nonceConflictTotal = 0;
  private _rbfBumpTotal = 0;

  incSubmitted() { this._txSubmittedTotal++; }
  incConfirmed() { this._txConfirmedTotal++; }
  incFailed()    { this._txFailedTotal++; }
  incDlq()       { this._txDlqTotal++; }
  incNonceConflict() { this._nonceConflictTotal++; }
  incRbfBump()   { this._rbfBumpTotal++; }

  snapshot() {
    return {
      tx_submitted_total:    this._txSubmittedTotal,
      tx_confirmed_total:    this._txConfirmedTotal,
      tx_failed_total:       this._txFailedTotal,
      tx_dlq_total:          this._txDlqTotal,
      nonce_conflict_total:  this._nonceConflictTotal,
      rbf_bump_total:        this._rbfBumpTotal,
    };
  }
}
