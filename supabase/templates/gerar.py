"""Gera os modelos de e-mail do AUTH do Racha (en/pt/es num arquivo só).

    cd supabase/templates && python3 gerar.py

Depois, cole cada `<nome>.html` (corpo) e `<nome>.subject.txt` (assunto) em
Supabase → Authentication → Emails, no projeto racha. O idioma sai de
`.Data.lang` — o user_metadata que o `auth.ts` grava no cadastro.
"""

T = {
    'confirmation': {
        'subject': {'en': 'Confirm your Racha account', 'pt': 'Confirme sua conta no Racha', 'es': 'Confirma tu cuenta de Racha'},
        'title': {'en': 'Confirm your e-mail', 'pt': 'Confirme seu e-mail', 'es': 'Confirma tu correo'},
        'body': {'en': 'You created a Racha owner account with this e-mail. Confirm it to open your restaurant panel.',
                 'pt': 'Você criou uma conta de dono no Racha com este e-mail. Confirme para abrir o painel do seu restaurante.',
                 'es': 'Creaste una cuenta de dueño en Racha con este correo. Confírmala para abrir el panel de tu restaurante.'},
        'cta': {'en': 'Confirm e-mail', 'pt': 'Confirmar e-mail', 'es': 'Confirmar correo'},
        'foot': {'en': 'Open the link in the same browser where you signed up. If it was not you, ignore this e-mail — no account is created without this confirmation.',
                 'pt': 'Abra o link no mesmo navegador em que você se cadastrou. Se não foi você, ignore este e-mail — nenhuma conta é criada sem a confirmação.',
                 'es': 'Abre el enlace en el mismo navegador donde te registraste. Si no fuiste tú, ignora este correo: ninguna cuenta se crea sin esta confirmación.'},
    },
    'recovery': {
        'subject': {'en': 'Reset your Racha password', 'pt': 'Redefina sua senha do Racha', 'es': 'Restablece tu contraseña de Racha'},
        'title': {'en': 'Choose a new password', 'pt': 'Escolha uma senha nova', 'es': 'Elige una contraseña nueva'},
        'body': {'en': 'Someone asked to reset the password of the Racha account {{ .Email }}. The link below opens the screen to choose a new one.',
                 'pt': 'Pediram a redefinição da senha da conta {{ .Email }} no Racha. O link abaixo abre a tela para escolher uma nova.',
                 'es': 'Pidieron restablecer la contraseña de la cuenta {{ .Email }} en Racha. El enlace abre la pantalla para elegir una nueva.'},
        'cta': {'en': 'Choose new password', 'pt': 'Escolher senha nova', 'es': 'Elegir contraseña nueva'},
        'foot': {'en': 'Open the link in the same browser where you asked for it. If it was not you, ignore this e-mail — your password stays the same.',
                 'pt': 'Abra o link no mesmo navegador em que você pediu. Se não foi você, ignore este e-mail — sua senha continua a mesma.',
                 'es': 'Abre el enlace en el mismo navegador donde lo pediste. Si no fuiste tú, ignora este correo: tu contraseña sigue igual.'},
    },
    'email_change': {
        'subject': {'en': 'Confirm the new e-mail of your Racha account', 'pt': 'Confirme o novo e-mail da sua conta no Racha', 'es': 'Confirma el nuevo correo de tu cuenta de Racha'},
        'title': {'en': 'Confirm the e-mail change', 'pt': 'Confirme a troca de e-mail', 'es': 'Confirma el cambio de correo'},
        # Sem o endereço ANTIGO: o e-mail vai pro novo, e quem escolhe o antigo pode
        # ser um atacante que escreve recado no endereço (segurança, PR #22, LOW-1).
        'body': {'en': 'A Racha account asked to change its e-mail to {{ .NewEmail }}.',
                 'pt': 'Uma conta do Racha pediu para trocar o e-mail para {{ .NewEmail }}.',
                 'es': 'Una cuenta de Racha pidió cambiar su correo a {{ .NewEmail }}.'},
        'cta': {'en': 'Confirm change', 'pt': 'Confirmar troca', 'es': 'Confirmar cambio'},
        'foot': {'en': 'Open the link in the same browser where you asked for it. If you did not ask for this change, do not click. If the account is yours, change its password.',
                 'pt': 'Abra o link no mesmo navegador em que você pediu. Se você não pediu esta troca, não clique. Se a conta é sua, troque a senha.',
                 'es': 'Abre el enlace en el mismo navegador donde lo pediste. Si no pediste este cambio, no hagas clic. Si la cuenta es tuya, cambia la contraseña.'},
    },
}

# `printf "%v"` porque `eq` com valor AUSENTE quebra o modelo inteiro no Go
# (contas antigas não têm `lang`). Sem idioma, inglês — o padrão da plataforma.
LANG = '{{ $l := printf "%v" .Data.lang }}'


def pick(d):
    return ('{{ if eq $l "pt" }}' + d['pt'] + '{{ else if eq $l "es" }}' + d['es']
            + '{{ else }}' + d['en'] + '{{ end }}')


HEAD = """<!--
  Modelo de e-mail do AUTH do Racha (Supabase → Authentication → Emails).
  GERADO por supabase/templates/gerar.py — edite lá e cole no painel.
-->
"""

SANS = 'Manrope,Helvetica,Arial,sans-serif'


def corpo(d):
    return HEAD + LANG + f"""<!doctype html>
<html><body style="margin:0;padding:0;background:#F2F0EB;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F2F0EB;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#F8F7F3;border:1px solid #DDD9D0;border-radius:14px;">
<tr><td style="padding:28px 28px 8px;font-family:{SANS};font-size:15px;font-weight:700;letter-spacing:.02em;color:#161714;">Racha</td></tr>
<tr><td style="padding:8px 28px 0;font-family:Newsreader,Georgia,serif;font-size:26px;line-height:1.2;color:#161714;">{pick(d['title'])}</td></tr>
<tr><td style="padding:14px 28px 0;font-family:{SANS};font-size:15px;line-height:1.55;color:#3A3B36;">{pick(d['body'])}</td></tr>
<tr><td style="padding:24px 28px;"><a href="{{{{ .ConfirmationURL }}}}" style="display:inline-block;background:#161714;color:#F8F7F3;font-family:{SANS};font-size:15px;font-weight:600;text-decoration:none;padding:13px 22px;border-radius:999px;">{pick(d['cta'])}</a></td></tr>
<tr><td style="padding:0 28px 28px;font-family:{SANS};font-size:13px;line-height:1.5;color:#6B6C66;">{pick(d['foot'])}</td></tr>
</table>
</td></tr></table>
</body></html>
"""


if __name__ == '__main__':
    for nome, d in T.items():
        with open(f'{nome}.html', 'w') as f:
            f.write(corpo(d))
        with open(f'{nome}.subject.txt', 'w') as f:
            f.write(LANG + pick(d['subject']) + '\n')
    print('ok')
