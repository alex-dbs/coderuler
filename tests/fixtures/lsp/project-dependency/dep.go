package lspdep

func External() {
	Inner()
}

func Inner() {
	Deep()
}

func Deep() {}
