;; OracleIntegrator.clar

(define-constant ERR-UNAUTHORIZED u200)
(define-constant ERR-ORACLE-EXISTS u201)
(define-constant ERR-ORACLE-NOT-FOUND u202)
(define-constant ERR-PREDICTION-EXISTS u203)
(define-constant ERR-INVALID-SIGNATURE u204)
(define-constant ERR-EXPIRED-SIGNATURE u205)
(define-constant ERR-INVALID-ROUND u206)
(define-constant ERR-ROUND-CLOSED u207)
(define-constant ERR-INSUFFICIENT-ORACLES u208)

(define-data-var admin principal tx-sender)
(define-data-var min-oracles uint u3)
(define-data-var signature-validity uint u100)

(define-map oracles principal {
    registered-at: uint,
    stake: uint,
    is-active: bool,
    reputation: uint
})

(define-map predictions
    { data-id: uint, round: uint }
    {
        predicted-failure: bool,
        confidence: uint,
        timestamp: uint,
        oracle-count: uint,
        finalized: bool
    }
)

(define-map oracle-votes
    { data-id: uint, round: uint, oracle: principal }
    {
        vote: bool,
        confidence: uint,
        signature: (buff 65),
        submitted-at: uint
    }
)

(define-map active-rounds uint uint)

(define-read-only (get-oracle (oracle principal))
    (map-get? oracles oracle)
)

(define-read-only (get-prediction (data-id uint) (round uint))
    (map-get? predictions { data-id: data-id, round: round })
)

(define-read-only (get-vote (data-id uint) (round uint) (oracle principal))
    (map-get? oracle-votes { data-id: data-id, round: round, oracle: oracle })
)

(define-read-only (get-active-round (data-id uint))
    (map-get? active-rounds data-id)
)

(define-private (is-admin)
    (is-eq tx-sender (var-get admin))
)

(define-private (validate-signature (msg (buff 32)) (sig (buff 65)) (pubkey principal))
    (is-ok (secp256k1-verify msg sig pubkey))
)

(define-private (is-oracle-active (oracle principal))
    (match (map-get? oracles oracle)
        info (get is-active info)
        false
    )
)

(define-public (register-oracle (stake uint))
    (let ((oracle tx-sender))
        (asserts! (is-none (map-get? oracles oracle)) (err ERR-ORACLE-EXISTS))
        (asserts! (>= stake u1000000) (err ERR-UNAUTHORIZED))
        (try! (stx-transfer? stake oracle (as-contract tx-sender)))
        (map-set oracles oracle {
            registered-at: block-height,
            stake: stake,
            is-active: true,
            reputation: u100
        })
        (ok true)
    )
)

(define-public (deregister-oracle)
    (let ((oracle tx-sender)
          (info (unwrap! (map-get? oracles oracle) (err ERR-ORACLE-NOT-FOUND))))
        (asserts! (get is-active info) (err ERR-ORACLE-NOT-FOUND))
        (map-set oracles oracle (merge info { is-active: false }))
        (try! (as-contract (stx-transfer? (get stake info) tx-sender oracle)))
        (ok true)
    )
)

(define-public (start-prediction-round (data-id uint))
    (let ((round (+ (default-to u0 (map-get? active-rounds data-id)) u1)))
        (asserts! (is-none (map-get? predictions { data-id: data-id, round: round })) (err ERR-PREDICTION-EXISTS))
        (map-set active-rounds data-id round)
        (map-set predictions { data-id: data-id, round: round } {
            predicted-failure: false,
            confidence: u0,
            timestamp: block-height,
            oracle-count: u0,
            finalized: false
        })
        (ok round)
    )
)

(define-public (submit-prediction
    (data-id uint)
    (round uint)
    (predicted-failure bool)
    (confidence uint)
    (signature (buff 65))
)
    (let ((oracle tx-sender)
          (msg-hash (hash160 (concat (concat (to-consensus-buff? data-id) (to-consensus-buff? round)) (concat (to-consensus-buff? predicted-failure) (to-consensus-buff? confidence))))))
        (asserts! (is-oracle-active oracle) (err ERR-ORACLE-NOT-FOUND))
        (asserts! (is-eq round (unwrap! (map-get? active-rounds data-id) (err ERR-INVALID-ROUND))) (err ERR-INVALID-ROUND))
        (asserts! (is-none (map-get? oracle-votes { data-id: data-id, round: round, oracle: oracle })) (err ERR-UNAUTHORIZED))
        (asserts! (<= (- block-height (default-to u0 (get timestamp (unwrap! (map-get? predictions { data-id: data-id, round: round }) (err ERR-INVALID-ROUND))))) (var-get signature-validity)) (err ERR-EXPIRED-SIGNATURE))
        (asserts! (validate-signature msg-hash signature oracle) (err ERR-INVALID-SIGNATURE))
        (asserts! (<= confidence u100) (err ERR-UNAUTHORIZED))

        (map-set oracle-votes { data-id: data-id, round: round, oracle: oracle } {
            vote: predicted-failure,
            confidence: confidence,
            signature: signature,
            submitted-at: block-height
        })

        (let ((pred (unwrap! (map-get? predictions { data-id: data-id, round: round }) (err ERR-INVALID-ROUND)))
              (new-count (+ (get oracle-count pred) u1)))
            (map-set predictions { data-id: data-id, round: round }
                (merge pred {
                    oracle-count: new-count,
                    predicted-failure: (if predicted-failure pred (get predicted-failure pred)),
                    confidence: (if (> confidence (get confidence pred)) confidence (get confidence pred))
                })
            )

            (if (>= new-count (var-get min-oracles))
                (begin
                    (map-set predictions { data-id: data-id, round: round }
                        (merge (unwrap! (map-get? predictions { data-id: data-id, round: round }) (err ERR-INVALID-ROUND)) { finalized: true }))
                    (map-delete active-rounds data-id)
                    (print { event: "prediction-finalized", data-id: data-id, round: round, failure: predicted-failure })
                )
                (ok false)
            )
            (ok true)
        )
    )
)

(define-public (set-min-oracles (new-min uint))
    (begin
        (asserts! (is-admin) (err ERR-UNAUTHORIZED))
        (asserts! (>= new-min u2) (err ERR-INSUFFICIENT-ORACLES))
        (var-set min-oracles new-min)
        (ok true)
    )
)

(define-public (set-signature-validity (blocks uint))
    (begin
        (asserts! (is-admin) (err ERR-UNAUTHORIZED))
        (asserts! (> blocks u0) (err ERR-UNAUTHORIZED))
        (var-set signature-validity blocks)
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

(define-read-only (is-prediction-finalized (data-id uint) (round uint))
    (match (map-get? predictions { data-id: data-id, round: round })
        pred (get finalized pred)
        false
    )
)