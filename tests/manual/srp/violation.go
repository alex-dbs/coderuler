package srp

import "net/smtp"

type TOTO struct {
	users  map[string]string
	sender string
}

func (t TOTO) GetUser(id string) (string, bool) {
	user, found := t.users[id]
	return user, found
}

func (t TOTO) SendEmail(to, subject, body string) error {
	message := []byte("Subject: " + subject + "\r\n\r\n" + body)
	return smtp.SendMail("localhost:25", nil, t.sender, []string{to}, message)
}
