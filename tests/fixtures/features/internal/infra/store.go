package infra

func OpenStore(path string) string {
	return path
}

func BusinessPolicy() string {
	return "policy"
}

func MustOpen(path string) string {
	if path == "" {
		panic("empty path")
	}
	return path
}
