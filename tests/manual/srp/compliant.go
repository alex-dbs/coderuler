package srp

type UserService struct {
	users map[string]string
}

func (s UserService) GetUser(id string) (string, bool) {
	user, found := s.users[id]
	return user, found
}

func (s UserService) CreateUser(id, name string) {
	s.users[id] = name
}

func (s UserService) DeleteUser(id string) {
	delete(s.users, id)
}
