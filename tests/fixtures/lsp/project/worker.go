package lspfixture

type Runner interface {
	Run()
}

type Worker struct{}

func (Worker) Run() {
	Second()
}

func Use(r Runner, w Worker) {
	r.Run()
	w.Run()
}
