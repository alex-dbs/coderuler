package store

func filterScores(scores []int) []int {
    out := make([]int, 0, len(scores))
    for _, score := range scores {
        if score > 0 {
            out = append(out, score)
        }
    }
    return out
}
