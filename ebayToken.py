python3 -c "
import urllib.request, urllib.parse, base64

client_id     = 'JuanRodr-autoinx-PRD-9bf324dd4-5ef826e2'
client_secret = 'YOUR_CERT_ID'
code          = 'PASTE_FULL_RAW_CODE_HERE'
redirect_uri  = 'Juan_Rodriguez-JuanRodr-autoin-ygvgij'

credentials = base64.b64encode(f'{client_id}:{client_secret}'.encode()).decode()
data = urllib.parse.urlencode({
    'grant_type':   'authorization_code',
    'code':         urllib.parse.unquote(code),
    'redirect_uri': redirect_uri
}).encode()

req = urllib.request.Request(
    'https://api.ebay.com/identity/v1/oauth2/token',
    data=data,
    headers={
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': f'Basic {credentials}'
    }
)
with urllib.request.urlopen(req) as res:
    print(res.read().decode())
"
