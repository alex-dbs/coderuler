package lspfixture

import (
	"example.com/lspdep"
	"example.com/lspfixture/other"
)

func Seed() {
	First()
	Second()
	Shared()
	other.Shared()
	lspdep.External()
}

func First() {
	Leaf()
}

func Second() {
	Leaf()
}

func Leaf() {
	Deep()
}

func Deep() {}

func Shared() {}

func Caller() {
	Seed()
}

func Grandcaller() {
	Caller()
}

func Greatcaller() {
	Grandcaller()
}

func CycleA() {
	CycleB()
}

func CycleB() {
	CycleA()
}
