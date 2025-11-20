(define-constant ERR-UNAUTHORIZED u100)
(define-constant ERR-INVALID-HASH u101)
(define-constant ERR-DUPLICATE-DATA u102)
(define-constant ERR-DATA-NOT-FOUND u103)
(define-constant ERR-INVALID-DEVICE u104)
(define-constant ERR-INVALID-METADATA u105)
(define-constant ERR-INVALID-TIMESTAMP u106)
(define-constant ERR-MAX-DATA-EXCEEDED u107)
(define-constant ERR-DEVICE-NOT-REGISTERED u108)
(define-constant ERR-HASH-MISMATCH u109)

(define-data-var next-data-id uint u0)
(define-data-var max-data-entries uint u1000000)
(define-data-var admin principal tx-sender)

(define-map sensor-data uint {
    data-hash: (buff 32),
    device-id: principal,
    timestamp: uint,
    metadata: (string-ascii 256),
    block-height: uint,
    sequence: uint
})

(define-map device-registry principal {
    registered-at: uint,
    data-count: uint,
    last-sequence: uint,
    is-active: bool
})

(define-map data-by-device { device: principal, sequence: uint } uint)
(define-map data-by-hash (buff 32) uint)

(define-read-only (get-data-entry (id uint))
    (map-get? sensor-data id)
)

(define-read-only (get-data-by-hash (hash (buff 32)))
    (map-get? data-by-hash hash)
)

(define-read-only (get-device-info (device principal))
    (map-get? device-registry device)
)

(define-read-only (get-data-id-by-device-sequence (device principal) (sequence uint))
    (map-get? data-by-device { device: device, sequence: sequence })
)

(define-read-only (verify-data-integrity (id uint) (expected-hash (buff 32)))
    (match (map-get? sensor-data id)
        entry (is-eq (get data-hash entry) expected-hash)
        false
    )
)

(define-read-only (is-data-unique (hash (buff 32)))
    (is-none (map-get? data-by-hash hash))
)

(define-read-only (get-latest-sequence (device principal))
    (default-to u0 (get last-sequence (map-get? device-registry device)))
)

(define-read-only (get-total-data-count)
    (ok (var-get next-data-id))
)

(define-private (validate-hash (hash (buff 32)))
    (if (is-eq (len hash) u32)
        (ok true)
        (err ERR-INVALID-HASH)
    )
)

(define-private (validate-metadata (metadata (string-ascii 256)))
    (if (<= (len metadata) u256)
        (ok true)
        (err ERR-INVALID-METADATA)
    )
)

(define-private (validate-device-active (device principal))
    (match (map-get? device-registry device)
        info (get is-active info)
        false
    )
)

(define-private (validate-sequence (device principal) (sequence uint))
    (let ((last-seq (get-latest-sequence device)))
        (if (is-eq sequence (+ last-seq u1))
            (ok true)
            (err ERR-INVALID-TIMESTAMP)
        )
    )
)

(define-public (register-device)
    (let ((device tx-sender))
        (asserts! (is-none (map-get? device-registry device)) (err ERR-DUPLICATE-DATA))
        (map-set device-registry device {
            registered-at: block-height,
            data-count: u0,
            last-sequence: u0,
            is-active: true
        })
        (ok true)
    )
)

(define-public (deactivate-device (device principal))
    (begin
        (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
        (match (map-get? device-registry device)
            info (map-set device-registry device (merge info { is-active: false }))
            (err ERR-DEVICE-NOT-REGISTERED)
        )
        (ok true)
    )
)

(define-public (set-admin (new-admin principal))
    (begin
        (asserts! (is-eq tx-sender (var-get admin)) (err ERR-UNAUTHORIZED))
        (var-set admin new-admin)
        (ok true)
    )
)

(define-public (register-sensor-data
    (data-hash (buff 32))
    (device-id principal)
    (metadata (string-ascii 256))
    (sequence uint)
)
    (let (
        (new-id (var-get next-data-id))
        (current-max (var-get max-data-entries))
        (caller tx-sender)
    )
        (asserts! (< new-id current-max) (err ERR-MAX-DATA-EXCEEDED))
        (try! (validate-hash data-hash))
        (try! (validate-metadata metadata))
        (asserts! (is-eq caller device-id) (err ERR-UNAUTHORIZED))
        (asserts! (validate-device-active device-id) (err ERR-DEVICE-NOT-REGISTERED))
        (try! (validate-sequence device-id sequence))
        (asserts! (is-data-unique data-hash) (err ERR-DUPLICATE-DATA))

        (map-set sensor-data new-id {
            data-hash: data-hash,
            device-id: device-id,
            timestamp: block-height,
            metadata: metadata,
            block-height: block-height,
            sequence: sequence
        })
        (map-set data-by-hash data-hash new-id)
        (map-set data-by-device { device: device-id, sequence: sequence } new-id)

        (match (map-get? device-registry device-id)
            device-info
                (map-set device-registry device-id
                    (merge device-info {
                        data-count: (+ (get data-count device-info) u1),
                        last-sequence: sequence
                    })
                )
            (err ERR-DEVICE-NOT-REGISTERED)
        )

        (var-set next-data-id (+ new-id u1))
        (print { event: "data-registered", id: new-id, device: device-id, hash: data-hash })
        (ok new-id)
    )
)

(define-public (batch-register-data
    (entries (list 10 { hash: (buff 32), device: principal, metadata: (string-ascii 256), sequence: uint }))
)
    (fold ok entries (lambda (entry acc)
        (if (is-ok acc)
            (register-sensor-data
                (get hash entry)
                (get device entry)
                (get metadata entry)
                (get sequence entry)
            )
            acc
        )
    ))
)

(define-read-only (get-device-data-range
    (device principal)
    (start-sequence uint)
    (end-sequence uint)
)
    (let ((ids (filter
                (lambda (seq) (and (>= seq start-sequence) (<= seq end-sequence)))
                (list start-sequence (+ start-sequence u1) (+ start-sequence u2) (+ start-sequence u3) (+ start-sequence u4)
                      (+ start-sequence u5) (+ start-sequence u6) (+ start-sequence u7) (+ start-sequence u8) (+ start-sequence u9))
            )))
        (map (lambda (seq) (map-get? data-by-device { device: device, sequence: seq })) ids)
    )
)