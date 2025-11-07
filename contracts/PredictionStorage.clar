;; PredictionStorage.clar

(define-constant ERR-UNAUTHORIZED u300)
(define-constant ERR-PREDICTION-NOT-FINALIZED u301)
(define-constant ERR-DATA-ID-MISMATCH u302)
(define-constant ERR-INVALID-CONFIDENCE u303)
(define-constant ERR-ROUND-NOT-FOUND u304)
(define-constant ERR-ALREADY-ARCHIVED u305)

(define-data-var admin principal tx-sender)

(define-map finalized-predictions
    uint
    {
        data-id: uint,
        round: uint,
        predicted-failure: bool,
        confidence: uint,
        oracle-count: uint,
        finalized-at: uint,
        archived: bool
    }
)

(define-map device-prediction-history
    { device: principal, data-id: uint }
    uint
)

(define-map latest-prediction-by-device principal uint)

(define-read-only (get-finalized-prediction (data-id uint))
    (map-get? finalized-predictions data-id)
)

(define-read-only (get-prediction-for-device (device principal) (data-id uint))
    (map-get? device-prediction-history { device: device, data-id: data-id })
)

(define-read-only (get-latest-prediction-id (device principal))
    (map-get? latest-prediction-by-device device)
)

(define-read-only (is-prediction-archived (data-id uint))
    (match (map-get? finalized-predictions data-id)
        pred (get archived pred)
        false
    )
)

(define-private (is-admin)
    (is-eq tx-sender (var-get admin))
)

(define-public (archive-prediction
    (data-id uint)
    (round uint)
    (predicted-failure bool)
    (confidence uint)
    (oracle-count uint)
)
    (let (
        (existing (map-get? finalized-predictions data-id))
    )
        (asserts! (is-none existing) (err ERR-ALREADY-ARCHIVED))
        (asserts! (<= confidence u100) (err ERR-INVALID-CONFIDENCE))
        (asserts! (> oracle-count u0) (err ERR-UNAUTHORIZED))

        (map-set finalized-predictions data-id {
            data-id: data-id,
            round: round,
            predicted-failure: predicted-failure,
            confidence: confidence,
            oracle-count: oracle-count,
            finalized-at: block-height,
            archived: true
        })

        (ok true)
    )
)

(define-public (store-finalized-prediction
    (data-id uint)
    (device-id principal)
    (round uint)
    (predicted-failure bool)
    (confidence uint)
    (oracle-count uint)
)
    (begin
        (asserts! (is-eq contract-caller .OracleIntegrator) (err ERR-UNAUTHORIZED))
        (asserts! (is-none (map-get? finalized-predictions data-id)) (err ERR-ALREADY-ARCHIVED))

        (map-set finalized-predictions data-id {
            data-id: data-id,
            round: round,
            predicted-failure: predicted-failure,
            confidence: confidence,
            oracle-count: oracle-count,
            finalized-at: block-height,
            archived: false
        })

        (map-set device-prediction-history
            { device: device-id, data-id: data-id }
            data-id
        )

        (map-set latest-prediction-by-device device-id data-id)

        (print {
            event: "prediction-stored",
            data-id: data-id,
            device: device-id,
            failure: predicted-failure,
            confidence: confidence
        })

        (ok data-id)
    )
)

(define-public (mark-prediction-archived (data-id uint))
    (let ((pred (unwrap! (map-get? finalized-predictions data-id) (err ERR-ROUND-NOT-FOUND))))
        (asserts! (is-admin) (err ERR-UNAUTHORIZED))
        (map-set finalized-predictions data-id
            (merge pred { archived: true })
        )
        (ok true)
    )
)

(define-public (transfer-admin (new-admin principal))
    (begin
        (asserts! (is-admin) (err ERR-UNAUTHORIZED))
        (var-set admin new-admin)
        (ok true)
    )
)

(define-read-only (get-prediction-summary (data-id uint))
    (match (map-get? finalized-predictions data-id)
        pred (some {
            predicted-failure: (get predicted-failure pred),
            confidence: (get confidence pred),
            oracle-count: (get oracle-count pred),
            archived: (get archived pred)
        })
        none
    )
)

(define-read-only (get-device-prediction-timeline (device principal))
    (let (
        (latest-id (default-to u0 (map-get? latest-prediction-by-device device)))
    )
        (fold (lambda (id acc)
            (match (map-get? finalized-predictions id)
                p (cons {
                    data-id: id,
                    failure: (get predicted-failure p),
                    confidence: (get confidence p),
                    timestamp: (get finalized-at p)
                } acc)
                acc
            )
        ) (list latest-id) (list))
    )
)