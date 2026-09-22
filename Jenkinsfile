pipeline {
  agent { label 'pr-container' }

  options {
    skipDefaultCheckout(true)
    disableConcurrentBuilds(abortPrevious: true)
    timeout(time: 60, unit: 'MINUTES')
    buildDiscarder(logRotator(numToKeepStr: '30', daysToKeepStr: '14', artifactNumToKeepStr: '10'))
    timestamps()
  }

  environment {
    CI = 'true'
    FORCE_COLOR = '0'
    BANKAI_TEST_IMAGE = "bankai-backend:pr-${BUILD_TAG}"
  }

  stages {
        stage('Checkout and metadata') {
          steps {
            deleteDir()
            checkout scm
            sh '''
              set -eu
              mkdir -p reports/metadata
              git rev-parse HEAD > reports/metadata/git-sha.txt
              git status --short > reports/metadata/git-status.txt
              node --version > reports/metadata/node-version.txt
              npm --version > reports/metadata/npm-version.txt
            '''
          }
        }

        stage('Install locked dependencies') {
          steps {
            dir('backend') { sh 'npm ci --no-audit --no-fund' }
            dir('frontend') { sh 'npm ci --no-audit --no-fund' }
            dir('infrastructure') { sh 'npm ci --no-audit --no-fund' }
          }
        }

        stage('Backend typecheck') {
          steps { dir('backend') { sh 'npm run typecheck' } }
        }

        stage('Backend lint') {
          steps { dir('backend') { sh 'npm run lint' } }
        }

        stage('Backend unit tests') {
          steps { dir('backend') { sh 'npm run test:junit' } }
          post { always { junit testResults: 'backend/reports/junit.xml', allowEmptyResults: false } }
        }

        stage('Backend component tests') {
          steps { dir('backend') { sh 'npm run test:component:junit' } }
          post { always { junit testResults: 'backend/reports/component-junit.xml', allowEmptyResults: false } }
        }

        stage('Backend integration tests') {
          steps { dir('backend') { sh 'npm run test:integration:junit' } }
          post { always { junit testResults: 'backend/reports/integration-junit.xml', allowEmptyResults: false } }
        }

        stage('Backend production build') {
          steps { dir('backend') { sh 'npm run build' } }
        }

        stage('Frontend lint') {
          steps { dir('frontend') { sh 'npm run lint' } }
        }

        stage('Frontend unit and component tests') {
          steps { dir('frontend') { sh 'npm run test:junit' } }
          post { always { junit testResults: 'frontend/reports/junit.xml', allowEmptyResults: false } }
        }

        stage('Frontend production build') {
          steps { dir('frontend') { sh 'npm run build:verify' } }
        }

        stage('CDK formatting and compilation') {
          steps {
            dir('infrastructure') {
              sh 'npm run format:check'
              sh 'npm run build'
            }
          }
        }

        stage('CDK tests') {
          steps {
            dir('infrastructure') {
              sh 'npm test -- --runInBand'
              sh 'npm run validate:jenkins'
            }
          }
        }

        stage('CDK synthesis') {
          steps {
            dir('infrastructure') {
              sh '''
                set -eu
                rm -rf reports/cdk
                mkdir -p reports/cdk/nonprod reports/cdk/production
                npx cdk synth -c stage=nonprod --quiet --output reports/cdk/nonprod
                npx cdk synth -c stage=production --quiet --output reports/cdk/production
                npm run test:determinism | tee reports/cdk/determinism.txt
                node scripts/validate-templates.mjs reports/cdk/nonprod reports/cdk/production
              '''
            }
          }
        }
        stage('Infrastructure security scan') {
          steps {
            sh '''
              set -eu
              mkdir -p infrastructure/reports/security
              TRIVY=aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969
              docker run --rm -v "$PWD/infrastructure:/workspace:ro" -v "$PWD/infrastructure/reports/security:/output" "$TRIVY" config \
                --severity HIGH,CRITICAL --exit-code 1 --ignorefile /workspace/.trivyignore \
                --format json --output /output/nonprod.json /workspace/reports/cdk/nonprod
              docker run --rm -v "$PWD/infrastructure:/workspace:ro" -v "$PWD/infrastructure/reports/security:/output" "$TRIVY" config \
                --severity HIGH,CRITICAL --exit-code 1 --ignorefile /workspace/.trivyignore \
                --format json --output /output/production.json /workspace/reports/cdk/production
            '''
          }
          post { always { archiveArtifacts artifacts: 'infrastructure/reports/security/*.json', allowEmptyArchive: false, fingerprint: true } }
        }

        stage('Bankai image build') {
          steps {
            dir('backend') { sh 'docker build --progress=plain --pull=false -t "$BANKAI_TEST_IMAGE" .' }
          }
        }

        stage('API container health test') {
          steps {
            dir('backend') {
              sh 'BANKAI_TEST_IMAGE="$BANKAI_TEST_IMAGE" npx vitest run --config vitest.container.config.ts --testNamePattern="starts the production image" --reporter=default --reporter=junit --outputFile.junit=reports/api-container-junit.xml'
            }
          }
          post { always { junit testResults: 'backend/reports/api-container-junit.xml', allowEmptyResults: false } }
        }

        stage('Worker container startup test') {
          steps {
            dir('backend') {
              sh 'BANKAI_TEST_IMAGE="$BANKAI_TEST_IMAGE" npx vitest run --config vitest.container.config.ts --testNamePattern="runs the API and worker" --reporter=default --reporter=junit --outputFile.junit=reports/worker-container-junit.xml'
            }
          }
          post { always { junit testResults: 'backend/reports/worker-container-junit.xml', allowEmptyResults: false } }
        }

        stage('Container vulnerability scan') {
          steps {
            sh '''
              set -eu
              mkdir -p reports/security
              TRIVY=aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969
              docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/reports/security:/output" \
                "$TRIVY" image --scanners vuln --ignore-unfixed --severity HIGH,CRITICAL \
                --exit-code 1 --format json --output /output/vulnerabilities.json "$BANKAI_TEST_IMAGE"
            '''
          }
          post { always { archiveArtifacts artifacts: 'reports/security/vulnerabilities.json', allowEmptyArchive: false, fingerprint: true } }
        }

        stage('Secret scan') {
          steps {
            sh '''
              set -eu
              mkdir -p reports/security
              TRIVY=aquasec/trivy@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969
              GITLEAKS=zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f
              docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/reports/security:/output" \
                "$TRIVY" image --scanners secret --exit-code 1 --format json \
                --output /output/image-secrets.json "$BANKAI_TEST_IMAGE"
              docker run --rm -v "$PWD:/source:ro" -v "$PWD/reports/security:/output" \
                "$GITLEAKS" dir /source --config /source/.gitleaks.toml --redact \
                --report-format json --report-path /output/source-secrets.json --exit-code 1
            '''
          }
          post { always { archiveArtifacts artifacts: 'reports/security/*secrets.json', allowEmptyArchive: false, fingerprint: true } }
        }

        stage('SBOM generation') {
          steps {
            sh '''
              set -eu
              mkdir -p reports/sbom
              SYFT=anchore/syft@sha256:5999d209a342e55e9edf70bf8930fb5b86d8f2a783fa401178372c50e21b1d36
              docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/reports/sbom:/output" \
                "$SYFT" "docker:$BANKAI_TEST_IMAGE" -o syft-json=/output/bankai.syft.json \
                -o cyclonedx-json=/output/bankai.cyclonedx.json
            '''
          }
          post { always { archiveArtifacts artifacts: 'reports/sbom/*.json', allowEmptyArchive: false, fingerprint: true } }
        }

        stage('Publish reports') {
          steps {
            junit testResults: 'backend/reports/*junit.xml,frontend/reports/*junit.xml', allowEmptyResults: false
            archiveArtifacts artifacts: 'reports/**/*,backend/reports/**/*,frontend/reports/**/*,infrastructure/reports/**/*', allowEmptyArchive: false, fingerprint: true
          }
        }
  }

}
