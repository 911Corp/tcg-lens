import Foundation

struct LensResult: Identifiable, Equatable {
    let id: UUID
    let name: String
    let subtitle: String
    let price: String?
    let heat: Int?
    let state: State

    enum State { case provisional, identified, ambiguous, unknown }
}
