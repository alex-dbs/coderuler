import { test } from '@alex-dbs/coderuler';

export const aiTests = [
  test('a struct combines account lookup and email delivery').withFiles({
    'internal/user/user.go': `package user

type TOTO struct { users UserStore }

func (t TOTO) GetUser(id string) (User, error) {
    return t.users.GetUser(id)
}`,
    'internal/user/email.go': `package user

func (t TOTO) SendEmail(to, subject, body string) error {
    return nil
}`,
  }).violates(),
  test('a user service keeps related account operations together').withFiles({
    'internal/user/service.go': `package user

type UserService struct { users UserStore }

func (s UserService) GetUser(id string) (User, error) {
    return s.users.GetUser(id)
}

func (s UserService) CreateUser(name string) (User, error) {
    return s.users.CreateUser(name)
}

func (s UserService) DeleteUser(id string) error {
    return s.users.DeleteUser(id)
}`,
  }).passes(),
  test('a data-only struct has no mixed method responsibilities').withFiles({
    'internal/user/model.go': `package user

type User struct {
    ID string
    Name string
}`,
  }).passes(),
] as const;
