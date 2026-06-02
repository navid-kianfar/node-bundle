import dayjs from 'dayjs'

// A "secret" string we'll later grep for in the produced binary to sanity-check
// that source isn't shipped verbatim.
const SECRET_LICENSE = 'super-secret-license-key-ABC123'

function verifyLicense(input: string): string {
  return input === SECRET_LICENSE ? 'VALID' : 'invalid (set LICENSE env to test)'
}

function main(): void {
  const now = dayjs().format('YYYY-MM-DD HH:mm:ss')
  console.log('Hello from the protected sample app!')
  console.log('  bundled dependency (dayjs) says it is:', now)
  console.log('  node version :', process.version)
  console.log('  platform/arch:', process.platform, process.arch)
  console.log('  argv         :', process.argv.slice(2).join(' ') || '(none)')
  console.log('  license check:', verifyLicense(process.env.LICENSE ?? ''))
}

main()
