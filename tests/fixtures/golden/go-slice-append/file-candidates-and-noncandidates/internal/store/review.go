package store

func addTags(tags []string) []string {
    out := make([]string, len(tags))
    for _, tag := range tags {
        out = append(out, tag)
    }
    return out
}

func growScores(scores []int) []int {
    out := make([]int, 0, len(scores))
    for _, score := range scores {
        out = append(out, score)
    }
    return out
}

func copyItems(values []string) []string {
    out := make([]string, len(values))
    for i := range values {
        out[i] = values[i]
    }
    return out
}

func appendOnce(values []string) []string {
    return append(values, "extra")
}
